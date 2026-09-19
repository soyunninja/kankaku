/**
 * Map a {@link TaskView} (and its `WorkRecord`s) to the hub's `task_entries`
 * / `work_records` payload shapes. Pure, no I/O — see `contract.md` in
 * kankaku-hub for the exact field names/types this mirrors.
 *
 * The CRITICAL rule this file encodes: assignment (`client`/`project`/
 * `task`/`legacy_client_label`) is create-only. The owner reassigns rows in
 * the web; a later re-sync of the same task must never undo that, so
 * `buildTaskEntryUpdatePayload` never includes those fields. See
 * `buildTaskEntryCreatePayload` vs `buildTaskEntryUpdatePayload`.
 */

import type { TaskView } from "./task-view.ts";
import type { WorkRecord, WorkRole, WorkStatus } from "./work-record.ts";
import { finiteOrZero } from "./work-record.ts";
import type { Client, Project } from "./work-target.ts";

export type PromptPrivacyMode = "none" | "truncated" | "full";

export interface HubEntryContext {
  clients: Client[];
  projects: Project[];
  /** This machine's hostname or `KANKAKU_MACHINE`. */
  machine: string;
  /** `KANKAKU_SYNC_PROMPT`; see {@link applyPromptPrivacy}. */
  promptMode: PromptPrivacyMode;
}

export interface TaskAssignment {
  /** `clients` relation id, or `""` when no usable client could be resolved. */
  clientId: string;
  /** `projects` relation id, or `""`. */
  projectId: string;
  /** Only set (non-empty) for a task routed to the unassigned client. */
  legacyClientLabel: string;
  /** `true` when this task was routed to the catalog's unassigned ("Sin determinar") client. */
  routedToUnassigned: boolean;
}

/**
 * Resolve which client/project a task's `task_entries` row should link to.
 *
 * - A task whose `clientId` still exists in `clients` links to that client
 *   (regardless of its `active` flag — this is a historical fact, not a
 *   future selection), and to `projectId` too when it still exists and
 *   belongs to that client; otherwise the project relation is empty.
 * - A task with no `clientId`, or whose `clientId` no longer resolves,
 *   routes to the catalog's unassigned client (the row with
 *   `unassigned: true`), carrying forward the record's free-text `client`
 *   label (or its `clientName` when the label itself is absent) as
 *   `legacyClientLabel` — the historical backfill rule (proposal §5.3).
 */
export function resolveTaskAssignment(task: TaskView, clients: Client[], projects: Project[]): TaskAssignment {
  const client = task.clientId !== undefined ? clients.find((candidate) => candidate.id === task.clientId) : undefined;

  if (client) {
    const project =
      task.projectId !== undefined ? projects.find((candidate) => candidate.id === task.projectId && candidate.clientId === client.id) : undefined;
    return {
      clientId: client.id,
      projectId: project ? project.id : "",
      legacyClientLabel: "",
      routedToUnassigned: false,
    };
  }

  const unassigned = clients.find((candidate) => candidate.unassigned === true);
  return {
    clientId: unassigned ? unassigned.id : "",
    projectId: "",
    legacyClientLabel: task.client ?? task.clientName ?? "",
    routedToUnassigned: true,
  };
}

/**
 * Privacy transform for a prompt about to leave the machine
 * (`KANKAKU_SYNC_PROMPT`, default `none`): `none` omits it entirely,
 * `truncated` keeps the first 120 chars plus an ellipsis marker when
 * anything was cut, `full` sends it verbatim.
 */
export function applyPromptPrivacy(prompt: string, mode: PromptPrivacyMode): string {
  if (mode === "full") return prompt;
  if (mode === "truncated") return prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt;
  return "";
}

/**
 * PocketBase `date` fields read back as `"YYYY-MM-DD HH:MM:SS.mmmZ"` (space,
 * not `T`) though both forms are accepted on write; kankaku always sends
 * the space form so a round trip through the contract's documented shape
 * never depends on PocketBase's own normalization.
 */
function toPbDate(iso: string): string {
  return iso.replace("T", " ");
}

/** The `task_entries` fields present on every write. */
export interface TaskEntryPayload {
  task_id: string;
  client: string;
  project: string;
  task: string;
  started_at: string;
  ended_at: string;
  wall_ms: number;
  waiting_ms: number;
  work_ms: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  segments: Record<string, number>;
  subagent_count: number;
  runs: number;
  turns: number;
  status: WorkStatus;
  session_id: string;
  session_name: string;
  machine: string;
  model: string;
  prompt: string;
  legacy_client_label: string;
  repo_project: string;
  schema: number;
}

/** `TaskEntryPayload` minus the assignment fields — what an update sends. See the module docs' CRITICAL rule. */
export type TaskEntryUpdatePayload = Omit<TaskEntryPayload, "client" | "project" | "task" | "legacy_client_label">;

/** Build the full `task_entries` payload for a **create** request — every field, including assignment. */
export function buildTaskEntryCreatePayload(task: TaskView, ctx: HubEntryContext): TaskEntryPayload {
  const assignment = resolveTaskAssignment(task, ctx.clients, ctx.projects);
  return {
    task_id: task.id,
    client: assignment.clientId,
    project: assignment.projectId,
    task: "",
    started_at: toPbDate(task.startedAt),
    ended_at: toPbDate(task.endedAt),
    wall_ms: task.wallMs,
    waiting_ms: task.waitingMs,
    work_ms: task.workMs,
    input: finiteOrZero(task.usage.input),
    output: finiteOrZero(task.usage.output),
    cache_read: finiteOrZero(task.usage.cacheRead),
    cache_write: finiteOrZero(task.usage.cacheWrite),
    cost: finiteOrZero(task.usage.cost),
    segments: task.segments,
    subagent_count: task.subagents.length,
    runs: task.orchestrator.runs,
    turns: task.orchestrator.turns,
    status: task.status,
    session_id: task.sessionId ?? "",
    session_name: task.sessionName ?? "",
    machine: ctx.machine,
    model: task.orchestrator.model ?? "",
    prompt: applyPromptPrivacy(task.prompt, ctx.promptMode),
    legacy_client_label: assignment.legacyClientLabel,
    repo_project: task.project,
    schema: task.orchestrator.schema,
  };
}

/**
 * Build the `task_entries` payload for an **update** request: measurement
 * fields only — never `client`, `project`, `task` or `legacy_client_label`,
 * so a re-sync can never undo a reassignment made in the web. See the
 * module docs' CRITICAL rule.
 */
export function buildTaskEntryUpdatePayload(task: TaskView, ctx: HubEntryContext): TaskEntryUpdatePayload {
  const { client: _client, project: _project, task: _task, legacy_client_label: _legacy, ...rest } = buildTaskEntryCreatePayload(task, ctx);
  return rest;
}

/** One `work_records` row — raw per-`WorkRecord` detail, always `rollup: false`. */
export interface WorkRecordPayload {
  kankaku_id: string;
  task_entry: string;
  rollup: false;
  role: WorkRole;
  pid: number;
  parent_pid: number;
  started_at: string;
  settled_at: string;
  wall_ms: number;
  waiting_ms: number;
  work_ms: number;
  runs: number;
  turns: number;
  status: WorkStatus;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  segments: Record<string, number>;
  tools: Record<string, number>;
  session_id: string;
  prompt: string;
  machine: string;
  schema: number;
}

/**
 * Build one `work_records` payload from a raw {@link WorkRecord}
 * (orchestrator or subagent), linked to its parent `task_entries` row by
 * PocketBase id. `work_records` carries no assignment fields, so there is
 * no create/update distinction here — this payload is sent as-is either way.
 */
export function buildWorkRecordPayload(
  record: WorkRecord,
  taskEntryRecordId: string,
  ctx: { machine: string; promptMode: PromptPrivacyMode },
): WorkRecordPayload {
  return {
    kankaku_id: record.id,
    task_entry: taskEntryRecordId,
    rollup: false,
    role: record.role,
    pid: record.pid,
    parent_pid: record.parentPid,
    started_at: toPbDate(record.startedAt),
    settled_at: toPbDate(record.settledAt),
    wall_ms: record.wallMs,
    waiting_ms: record.waitingMs,
    work_ms: record.workMs,
    runs: record.runs,
    turns: record.turns,
    status: record.status,
    model: record.model ?? "",
    input: finiteOrZero(record.usage.input),
    output: finiteOrZero(record.usage.output),
    cache_read: finiteOrZero(record.usage.cacheRead),
    cache_write: finiteOrZero(record.usage.cacheWrite),
    cost: finiteOrZero(record.usage.cost),
    segments: record.segments ?? {},
    tools: record.tools,
    session_id: record.sessionId ?? "",
    prompt: applyPromptPrivacy(record.prompt, ctx.promptMode),
    machine: ctx.machine,
    schema: record.schema,
  };
}

/** Every `WorkRecord` folded into a task: the orchestrator plus its subagents, in that order. */
export function taskWorkRecords(task: TaskView): WorkRecord[] {
  return [task.orchestrator, ...task.subagents];
}
