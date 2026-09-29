import { ALREADY_ASSIGNED, NOT_ON_HUB, UNASSIGNED_LABEL, eligibleForBulk, planReassignment } from "./reassign-model.ts";
import type {
  HubRowSnapshot,
  PlanLine,
  PlanResult,
  ReassignCatalog,
  ReassignMode,
  ReassignTarget,
  RowOutcome,
} from "./reassign-model.ts";
import type { NavKeyHint } from "./nav-model.ts";

/** The picker's steps, in order; `project` and `task` come after `client`, and `task` is skipped when no project is chosen. */
export type PickerStep = "client" | "project" | "task" | "review" | "applying" | "result";

/** The id of the "no project" / "no task" option: an empty relation. */
export const NO_CHOICE = "";

export interface PickerOption {
  id: string;
  label: string;
}

/** One line of the scrolling list: options on the choosing steps, the plan on review, the outcomes on result. */
export interface PickerRow {
  text: string;
  tone?: "muted" | "error";
}

export interface PickerState {
  step: PickerStep;
  mode: ReassignMode;
  catalog: ReassignCatalog;
  targets: ReassignTarget[];
  rows: ReadonlyMap<string, HubRowSnapshot>;
  /** Selected line of the current step's list. Never wraps. */
  index: number;
  clientId?: string;
  projectId?: string;
  hubTaskId?: string;
  plan?: PlanResult;
  outcomes?: RowOutcome[];
}

export interface OpenPickerInput {
  mode: ReassignMode;
  catalog: ReassignCatalog;
  targets: ReassignTarget[];
  rows: ReadonlyMap<string, HubRowSnapshot>;
}

export function openPicker(input: OpenPickerInput): PickerState {
  return { step: "client", index: 0, ...input };
}

function clientLabel(name: string, unassigned: boolean | undefined): string {
  return unassigned === true ? UNASSIGNED_LABEL : name;
}

/** The selectable options of a choosing step (`client`, `project`, `task`); empty on every other step. */
export function pickerOptions(state: PickerState): PickerOption[] {
  const { catalog } = state;
  if (state.step === "client") {
    const active = catalog.clients.filter((client) => client.active);
    const ordered = [...active.filter((client) => client.unassigned !== true), ...active.filter((client) => client.unassigned === true)];
    return ordered.map((client) => ({ id: client.id, label: clientLabel(client.name, client.unassigned) }));
  }
  if (state.step === "project") {
    const projects = catalog.projects.filter((project) => project.active && project.clientId === state.clientId);
    return [...projects.map((project) => ({ id: project.id, label: project.name })), { id: NO_CHOICE, label: "no project" }];
  }
  if (state.step === "task") {
    const tasks = catalog.tasks.filter((task) => task.projectId === state.projectId && task.status !== "done");
    return [...tasks.map((task) => ({ id: task.id, label: task.title })), { id: NO_CHOICE, label: "no task" }];
  }
  return [];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function lines(state: PickerState): PlanLine[] {
  return state.plan?.ok ? state.plan.plan.lines : [];
}

function outcomeFor(state: PickerState, taskId: string): RowOutcome | undefined {
  return state.outcomes?.find((outcome) => outcome.taskId === taskId);
}

function skippedGroups(planLines: PlanLine[]): PickerRow[] {
  const groups: PickerRow[] = [];
  for (const reason of [ALREADY_ASSIGNED, NOT_ON_HUB]) {
    const count = planLines.filter((line) => line.kind === "skipped" && line.reason === reason).length;
    if (count > 0) groups.push({ text: `${count} not touched — ${reason}`, tone: "muted" });
  }
  return groups;
}

/** The scrolling list of the current step, as display rows. */
export function pickerRows(state: PickerState): PickerRow[] {
  if (state.step === "review") {
    if (state.plan === undefined || !state.plan.ok) return [{ text: `cannot reassign: ${state.plan?.ok === false ? state.plan.error : "no plan"}`, tone: "error" }];
    const planLines = lines(state);
    const rows: PickerRow[] = [];
    for (const line of planLines) {
      if (line.kind === "reassign") rows.push({ text: `${line.from} → ${line.to} · ${line.label}` });
      else if (line.kind === "unchanged") rows.push({ text: `already ${line.at} (unchanged) · ${line.label}`, tone: "muted" });
    }
    return [...rows, ...skippedGroups(planLines)];
  }
  if (state.step === "result" || state.step === "applying") {
    const planLines = lines(state);
    const rows: PickerRow[] = [];
    for (const line of planLines) {
      if (line.kind === "unchanged") rows.push({ text: `unchanged · ${line.label}`, tone: "muted" });
      if (line.kind !== "reassign") continue;
      if (state.step === "applying") {
        rows.push({ text: `sending · ${line.label}` });
        continue;
      }
      const outcome = outcomeFor(state, line.taskId);
      if (outcome === undefined) rows.push({ text: `failed: no answer from the hub · ${line.label}`, tone: "error" });
      else if (outcome.status === "reassigned") rows.push({ text: `reassigned · ${line.label}` });
      else rows.push({ text: `failed: ${outcome.reason} · ${line.label}`, tone: "error" });
    }
    return [...rows, ...skippedGroups(planLines)];
  }
  return pickerOptions(state).map((option) => ({ text: option.label }));
}

/** How many lines the current step's list has (what `moveSelection` clamps to). */
export function pickerRowCount(state: PickerState): number {
  return pickerRows(state).length;
}

function clamp(value: number, count: number): number {
  return Math.min(Math.max(value, 0), Math.max(count - 1, 0));
}

/** Move the selection by `delta` lines, clamped to the list (never wraps). */
export function moveSelection(state: PickerState, delta: number): PickerState {
  return { ...state, index: clamp(state.index + delta, pickerRowCount(state)) };
}

export function jumpSelection(state: PickerState, where: "first" | "last"): PickerState {
  return { ...state, index: where === "first" ? 0 : clamp(Number.MAX_SAFE_INTEGER, pickerRowCount(state)) };
}

function withPlan(state: PickerState): PickerState {
  const selection = {
    clientId: state.clientId ?? "",
    ...(state.projectId !== undefined ? { projectId: state.projectId } : {}),
    ...(state.hubTaskId !== undefined ? { hubTaskId: state.hubTaskId } : {}),
  };
  const plan = planReassignment({ rows: state.rows, tasks: state.targets, catalog: state.catalog, selection, mode: state.mode });
  return { ...state, step: "review", index: 0, plan };
}

/**
 * `enter`: take the selected option and go to the next step, or apply from
 * review. Returns `undefined` when the picker closes (from `result`); an
 * empty option list, a rejected plan and the `applying` step leave the
 * state as it is.
 */
export function advance(state: PickerState): PickerState | undefined {
  if (state.step === "result") return undefined;
  if (state.step === "applying") return state;

  if (state.step === "review") {
    if (state.plan === undefined || !state.plan.ok) return state;
    const hasChanges = state.plan.plan.lines.some((line) => line.kind === "reassign");
    return hasChanges ? { ...state, step: "applying", index: 0 } : { ...state, step: "result", index: 0, outcomes: [] };
  }

  const option = pickerOptions(state)[state.index];
  if (option === undefined) return state;

  if (state.step === "client") return { ...state, step: "project", index: 0, clientId: option.id };
  if (state.step === "project") {
    if (option.id === NO_CHOICE) return withPlan({ ...state, projectId: undefined });
    return { ...state, step: "task", index: 0, projectId: option.id };
  }
  return withPlan({ ...state, hubTaskId: option.id === NO_CHOICE ? undefined : option.id });
}

function without<T extends object>(state: T, ...keys: Array<keyof T>): T {
  const copy = { ...state };
  for (const key of keys) delete copy[key];
  return copy;
}

/** Select the option `id` in the list of `state` (used to land on the previous choice when going back). */
function selecting(state: PickerState, id: string | undefined): PickerState {
  const index = pickerOptions(state).findIndex((option) => option.id === (id ?? NO_CHOICE));
  return { ...state, index: Math.max(index, 0) };
}

/** `esc`/`←`: go back one step, restoring the previous choice; returns `undefined` when the picker closes (from `client` or `result`). */
export function back(state: PickerState): PickerState | undefined {
  switch (state.step) {
    case "client":
    case "result":
      return undefined;
    case "applying":
      return state;
    case "project":
      return selecting(without({ ...state, step: "client" as const }, "clientId", "projectId", "hubTaskId", "plan"), state.clientId);
    case "task":
      return selecting(without({ ...state, step: "project" as const }, "projectId", "hubTaskId", "plan"), state.projectId);
    case "review":
      return state.projectId !== undefined
        ? selecting(without({ ...state, step: "task" as const }, "plan"), state.hubTaskId)
        : selecting(without({ ...state, step: "project" as const }, "projectId", "hubTaskId", "plan"), undefined);
  }
}

/** The hub answered every PATCH: show the result. */
export function finishApplying(state: PickerState, outcomes: RowOutcome[]): PickerState {
  return { ...state, step: "result", index: 0, outcomes };
}

const STEP_TITLES: Record<PickerStep, string> = {
  client: "Client",
  project: "Project",
  task: "Task",
  review: "Review",
  applying: "Applying",
  result: "Result",
};

export function pickerTitle(state: PickerState): string {
  return `Reassign · ${STEP_TITLES[state.step]}`;
}

function subject(state: PickerState): string {
  if (state.mode === "single") return `"${state.targets[0]?.label ?? ""}"`;
  return plural(eligibleForBulk(state.targets, state.rows, state.catalog).length, "unassigned task");
}

function chosenClientName(state: PickerState): string {
  const client = state.catalog.clients.find((candidate) => candidate.id === state.clientId);
  return client === undefined ? "unknown client" : clientLabel(client.name, client.unassigned);
}

/** The two fixed lines above the list: what is being reassigned and what to do or what happened. Always two entries so the layout never shifts. */
export function pickerHeading(state: PickerState): [string, string] {
  switch (state.step) {
    case "client":
      return [`Reassign ${subject(state)}`, "Choose a client"];
    case "project":
      return [`Reassign ${subject(state)}`, `${chosenClientName(state)} — choose a project`];
    case "task": {
      const project = state.catalog.projects.find((candidate) => candidate.id === state.projectId);
      return [`Reassign ${subject(state)}`, `${chosenClientName(state)} · ${project?.name ?? "unknown project"} — choose a task`];
    }
    case "review": {
      if (state.plan === undefined || !state.plan.ok) return ["Cannot reassign", ""];
      const planLines = state.plan.plan.lines;
      const changes = planLines.filter((line) => line.kind === "reassign").length;
      const unchanged = planLines.filter((line) => line.kind === "unchanged").length;
      const skipped = planLines.filter((line) => line.kind === "skipped").length;
      const detail = [unchanged > 0 ? `${unchanged} unchanged` : "", skipped > 0 ? `${skipped} not touched` : ""].filter((part) => part !== "").join(" · ");
      return [changes > 0 ? `Move ${plural(changes, "task")} to ${state.plan.plan.destination}` : "Nothing to change", detail];
    }
    case "applying":
      return ["Applying…", "sending the changes to the hub"];
    case "result": {
      const planLines = lines(state);
      const outcomes = state.outcomes ?? [];
      const done = outcomes.filter((outcome) => outcome.status === "reassigned").length;
      const failed = planLines.filter((line) => line.kind === "reassign").length - done;
      const unchanged = planLines.filter((line) => line.kind === "unchanged").length;
      const skipped = planLines.filter((line) => line.kind === "skipped").length;
      const headline = [done > 0 ? `${done} reassigned` : "", unchanged > 0 ? `${unchanged} unchanged` : "", failed > 0 ? `${failed} failed` : ""].filter((part) => part !== "").join(" · ");
      return [headline === "" ? "Nothing changed" : headline, skipped > 0 ? `${skipped} not touched` : ""];
    }
  }
}

/** The footer key hints for the current step. */
export function pickerHints(state: PickerState): NavKeyHint[] {
  switch (state.step) {
    case "client":
      return [
        { key: "↑↓", label: "move" },
        { key: "enter", label: "next" },
        { key: "esc", label: "close" },
      ];
    case "project":
    case "task":
      return [
        { key: "↑↓", label: "move" },
        { key: "enter", label: "next" },
        { key: "esc", label: "back" },
      ];
    case "review":
      if (state.plan === undefined || !state.plan.ok) return [{ key: "esc", label: "back" }];
      return [
        { key: "↑↓", label: "scroll" },
        { key: "enter", label: "apply" },
        { key: "esc", label: "back" },
      ];
    case "applying":
      return [{ key: "…", label: "applying, please wait" }];
    case "result":
      return [
        { key: "↑↓", label: "scroll" },
        { key: "enter", label: "done" },
        { key: "esc", label: "done" },
      ];
  }
}
