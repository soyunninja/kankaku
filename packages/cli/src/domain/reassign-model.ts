import type { Client, HubTask, Project } from "kankaku-pi/domain";

/** Why a task is left out of a reassignment plan. User-facing text, shown verbatim. */
export const NOT_ON_HUB = "not on the hub yet — sync first";
export const ALREADY_ASSIGNED = "already assigned";

/** What the hub currently holds for one `task_entries` row; an empty relation is `""`, exactly as the hub stores it. */
export interface HubRowSnapshot {
  /** The PocketBase record id of the `task_entries` row (needed for the PATCH; never shown). */
  rowId: string;
  /** The kankaku task id (`task_entries.task_id`). */
  taskId: string;
  clientId: string;
  projectId: string;
  /** The hub `tasks` relation. Named `hubTaskId` so it is never confused with `taskId`. */
  hubTaskId: string;
}

/** The catalog a selection is validated against: what the hub last said about clients, projects and tasks. */
export interface ReassignCatalog {
  clients: Client[];
  projects: Project[];
  tasks: HubTask[];
}

/** The destination picked in the picker; absent project or task mean "no project" / "no task". */
export interface ReassignSelection {
  clientId: string;
  projectId?: string;
  hubTaskId?: string;
}

/** A local task the user asked about: its kankaku id and a short text to recognise it by. */
export interface ReassignTarget {
  taskId: string;
  label: string;
}

/** `single` reassigns exactly the chosen tasks; `bulk` touches only rows currently on the unassigned client. */
export type ReassignMode = "single" | "bulk";

/** The relation fields sent to the hub; `""` clears a relation. Nothing else is ever sent. */
export interface RelationPayload {
  client: string;
  project: string;
  task: string;
}

export type PlanLine =
  | { kind: "reassign"; taskId: string; label: string; rowId: string; from: string; to: string; payload: RelationPayload }
  | { kind: "unchanged"; taskId: string; label: string; at: string }
  | { kind: "skipped"; taskId: string; label: string; reason: typeof NOT_ON_HUB | typeof ALREADY_ASSIGNED };

export interface ReassignPlan {
  mode: ReassignMode;
  /** The chosen destination, by names. */
  destination: string;
  lines: PlanLine[];
}

/** A rejected selection carries a message and never a plan, so no payload can exist for it. */
export type PlanResult = { ok: true; plan: ReassignPlan } | { ok: false; error: string };

/** The result of one PATCH, in the order of the plan's `reassign` lines. */
export type RowOutcome = { taskId: string; status: "reassigned" } | { taskId: string; status: "failed"; reason: string };

const UNASSIGNED_LABEL = "unassigned";

function unassignedClient(clients: Client[]): Client | undefined {
  return clients.find((client) => client.unassigned === true);
}

/**
 * `Client`, `Client · Project` or `Client · Project › Task`, by names; the
 * unassigned client reads `unassigned`, a relation the catalog no longer
 * knows reads `unknown …`, never an id.
 */
export function describeAssignment(assignment: Pick<HubRowSnapshot, "clientId" | "projectId" | "hubTaskId">, catalog: ReassignCatalog): string {
  const client = catalog.clients.find((candidate) => candidate.id === assignment.clientId);
  const clientText =
    assignment.clientId === "" ? "no client" : client === undefined ? "unknown client" : client.unassigned === true ? UNASSIGNED_LABEL : client.name;
  if (assignment.projectId === "") return clientText;
  const project = catalog.projects.find((candidate) => candidate.id === assignment.projectId);
  const projectText = project?.name ?? "unknown project";
  if (assignment.hubTaskId === "") return `${clientText} · ${projectText}`;
  const task = catalog.tasks.find((candidate) => candidate.id === assignment.hubTaskId);
  return `${clientText} · ${projectText} › ${task?.title ?? "unknown task"}`;
}

/** The targets whose hub row exists and sits on the catalog's unassigned client: what `A` may touch. */
export function eligibleForBulk(targets: ReassignTarget[], rows: ReadonlyMap<string, HubRowSnapshot>, catalog: ReassignCatalog): ReassignTarget[] {
  const unassigned = unassignedClient(catalog.clients);
  if (unassigned === undefined) return [];
  return targets.filter((target) => rows.get(target.taskId)?.clientId === unassigned.id);
}

/** Validate `selection` against the catalog; returns the error message, or `undefined` when it is consistent. */
function validateSelection(selection: ReassignSelection, catalog: ReassignCatalog): string | undefined {
  const client = catalog.clients.find((candidate) => candidate.id === selection.clientId);
  if (client === undefined) return "unknown client";
  if (!client.active) return `client "${client.name}" is not active`;

  const projectId = selection.projectId ?? "";
  const hubTaskId = selection.hubTaskId ?? "";

  if (projectId === "") {
    return hubTaskId === "" ? undefined : "a task needs a project";
  }
  const project = catalog.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) return "unknown project";
  if (!project.active) return `project "${project.name}" is not active`;
  if (project.clientId !== client.id) return `project "${project.name}" does not belong to client "${client.name}"`;

  if (hubTaskId === "") return undefined;
  const task = catalog.tasks.find((candidate) => candidate.id === hubTaskId);
  if (task === undefined) return "unknown task";
  if (task.projectId !== project.id) return `task "${task.title}" does not belong to project "${project.name}"`;
  if (task.status === "done") return `task "${task.title}" is done`;
  return undefined;
}

export interface PlanInput {
  /** Hub rows found for the asked tasks, keyed by kankaku task id. */
  rows: ReadonlyMap<string, HubRowSnapshot>;
  tasks: ReassignTarget[];
  catalog: ReassignCatalog;
  selection: ReassignSelection;
  mode: ReassignMode;
}

/**
 * Turn a destination into one plan line per asked task. The selection is
 * validated first and rejects the whole plan, so an inconsistent choice
 * never yields a payload. A task with no hub row is skipped (sync first);
 * in `bulk` mode a row that is not on the unassigned client is skipped
 * (`already assigned`); a row that already has exactly the destination is
 * `unchanged`; the rest are `reassign` lines carrying the relation payload.
 * Pure: no request is made here.
 */
export function planReassignment(input: PlanInput): PlanResult {
  const { rows, tasks, catalog, selection, mode } = input;
  const error = validateSelection(selection, catalog);
  if (error !== undefined) return { ok: false, error };

  const payload: RelationPayload = { client: selection.clientId, project: selection.projectId ?? "", task: selection.hubTaskId ?? "" };
  const destination = describeAssignment({ clientId: payload.client, projectId: payload.project, hubTaskId: payload.task }, catalog);
  const unassigned = unassignedClient(catalog.clients);

  const lines: PlanLine[] = tasks.map((target): PlanLine => {
    const row = rows.get(target.taskId);
    if (row === undefined) return { kind: "skipped", taskId: target.taskId, label: target.label, reason: NOT_ON_HUB };
    if (mode === "bulk" && (unassigned === undefined || row.clientId !== unassigned.id)) {
      return { kind: "skipped", taskId: target.taskId, label: target.label, reason: ALREADY_ASSIGNED };
    }
    if (row.clientId === payload.client && row.projectId === payload.project && row.hubTaskId === payload.task) {
      return { kind: "unchanged", taskId: target.taskId, label: target.label, at: destination };
    }
    return {
      kind: "reassign",
      taskId: target.taskId,
      label: target.label,
      rowId: row.rowId,
      from: describeAssignment(row, catalog),
      to: destination,
      payload: { ...payload },
    };
  });

  return { ok: true, plan: { mode, destination, lines } };
}
