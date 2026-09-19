import { buildTasks } from "../domain/task-view.ts";
import type { SessionView, TaskView } from "../domain/task-view.ts";
import { localDay } from "../domain/day.ts";
import { finiteOrZero } from "../domain/work-record.ts";
import type { WorkRecord, WorkRole } from "../domain/work-record.ts";

export { localDay } from "../domain/day.ts";

export interface RoleTotals {
  workMs: number;
  waitingMs: number;
  wallMs: number;
  count: number;
  /** Estimated cost in USD, as priced by pi's model table. */
  cost: number;
  /** Per-tag total milliseconds summed across every record of this role. */
  segments: Record<string, number>;
}

export interface TaskTotals {
  count: number;
  wallMs: number;
  workMs: number;
  /** Estimated cost in USD, orchestrator and subagents combined. */
  cost: number;
  /** Per-tag total milliseconds summed across every task (orchestrator and subagents). */
  segments: Record<string, number>;
}

export type Summary = Record<WorkRole, RoleTotals> & { tasks: TaskTotals };

export interface SummarizeOptions {
  /** Local day in `YYYY-MM-DD` format. Defaults to today when `all` is not set. */
  day?: string;
  /** Include every record regardless of day. */
  all?: boolean;
}

const ROLES: WorkRole[] = ["orchestrator", "subagent"];

function emptyTotals(): RoleTotals {
  return { workMs: 0, waitingMs: 0, wallMs: 0, count: 0, cost: 0, segments: {} };
}

/** Add per-tag milliseconds from `segments` (missing on older records) into `into`. */
function addSegments(into: Record<string, number>, segments: Record<string, number> | undefined): void {
  for (const [tag, ms] of Object.entries(segments ?? {})) {
    into[tag] = (into[tag] ?? 0) + ms;
  }
}

/**
 * Aggregate work records by role, restricted to one local day unless `all`
 * is set. Also computes a `tasks` segment (union-based `wallMs`/`workMs`
 * over one orchestrator run and its subagents) for tasks whose `startedAt`
 * falls on the same day.
 */
export function summarize(records: WorkRecord[], options: SummarizeOptions): Summary {
  const targetDay = options.all ? undefined : (options.day ?? localDay(new Date().toISOString()));

  const summary: Summary = {
    orchestrator: emptyTotals(),
    subagent: emptyTotals(),
    tasks: { count: 0, wallMs: 0, workMs: 0, cost: 0, segments: {} },
  };

  for (const record of records) {
    if (targetDay !== undefined && localDay(record.startedAt) !== targetDay) continue;
    const totals = summary[record.role];
    totals.workMs += record.workMs;
    totals.waitingMs += record.waitingMs;
    totals.wallMs += record.wallMs;
    totals.count += 1;
    totals.cost += finiteOrZero(record.usage.cost);
    addSegments(totals.segments, record.segments);
  }

  const tasks = buildTasks(records).filter((task) => targetDay === undefined || localDay(task.startedAt) === targetDay);
  for (const task of tasks) {
    summary.tasks.count += 1;
    summary.tasks.wallMs += task.wallMs;
    summary.tasks.workMs += task.workMs;
    summary.tasks.cost += task.usage.cost;
    addSegments(summary.tasks.segments, task.segments);
  }

  return summary;
}

function formatMinutes(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** Estimated USD cost with two decimals, e.g. `$1.23`. */
function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Render non-zero segment tags as `tag Xm00s` pairs, sorted alphabetically, joined by `, `. Undefined when none are non-zero. */
function formatSegmentTags(segments: Record<string, number>): string | undefined {
  const tags = Object.keys(segments)
    .filter((tag) => segments[tag]! > 0)
    .sort();
  if (tags.length === 0) return undefined;
  return tags.map((tag) => `${tag} ${formatMinutes(segments[tag]!)}`).join(", ");
}

/** Render a short, human-readable summary for the `/kankaku` command. */
export function formatReport(summary: Summary): string {
  const lines = ROLES.map((role) => {
    const totals = summary[role];
    return `${role}: work ${formatMinutes(totals.workMs)}, waiting ${formatMinutes(totals.waitingMs)}, ${totals.count} record(s), ${formatCost(totals.cost)}`;
  });
  lines.push(
    `tasks: ${summary.tasks.count}, wall ${formatMinutes(summary.tasks.wallMs)}, work ${formatMinutes(summary.tasks.workMs)}, ${formatCost(summary.tasks.cost)}`,
  );
  const segmentTags = formatSegmentTags(summary.tasks.segments);
  if (segmentTags !== undefined) {
    lines.push(`segments: ${segmentTags}`);
  }
  return lines.join(" | ");
}

/** Maximum visible width of a task prompt before it is truncated with an ellipsis marker. */
const PROMPT_DISPLAY_LIMIT = 60;

/** Truncate `text` to `limit` visible characters, appending `…` (counted within the limit) when it was cut. */
function truncateWithEllipsis(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Render one line per task: time, client (when present), union-based wall/work, cost, non-zero segment tags, subagent count, and a truncated prompt (`…` marks a cut). */
export function formatTasks(tasks: TaskView[]): string {
  if (tasks.length === 0) return "no tasks";
  return tasks
    .map((task) => {
      const prompt = truncateWithEllipsis(task.prompt, PROMPT_DISPLAY_LIMIT);
      const segmentTags = formatSegmentTags(task.segments);
      const segmentPart = segmentTags !== undefined ? `  ${segmentTags}` : "";
      const clientPart = task.client !== undefined ? `  client:${task.client}` : "";
      return `${formatTime(task.startedAt)}${clientPart}  wall ${formatMinutes(task.wallMs)}  work ${formatMinutes(task.workMs)}  ${formatCost(task.usage.cost)}${segmentPart}  subagents ${task.subagents.length}  ${prompt}`;
    })
    .join("\n");
}

export interface ClientTotals {
  wallMs: number;
  waitingMs: number;
  workMs: number;
  /** Estimated cost in USD, summed across this client's tasks. */
  cost: number;
  count: number;
}

/** Client name under which tasks without a resolved client are grouped. */
const NO_CLIENT = "(none)";

/**
 * Aggregate tasks by billing client (see `domain/client-label.ts`), summing
 * work/waiting/wall time, cost, and task count. Tasks without a `client`
 * are grouped under `"(none)"`. Returned as a `Map` rather than a plain
 * object so an attacker-controlled client name can never repoint a
 * prototype property.
 */
export function summarizeByClient(tasks: TaskView[]): Map<string, ClientTotals> {
  const totals = new Map<string, ClientTotals>();
  for (const task of tasks) {
    const key = task.client ?? NO_CLIENT;
    const entry = totals.get(key) ?? { wallMs: 0, waitingMs: 0, workMs: 0, cost: 0, count: 0 };
    entry.wallMs += task.wallMs;
    entry.waitingMs += task.waitingMs;
    entry.workMs += task.workMs;
    entry.cost += finiteOrZero(task.usage.cost);
    entry.count += 1;
    totals.set(key, entry);
  }
  return totals;
}

export interface ProjectTotals {
  /** Display name: the project's `projectName`, or `"(no project)"` for the ungrouped bucket. */
  name: string;
  wallMs: number;
  waitingMs: number;
  workMs: number;
  /** Estimated cost in USD, summed across this project's tasks. */
  cost: number;
  count: number;
}

/** Key (and display name) under which tasks without a resolved project are grouped. */
const NO_PROJECT = "(no project)";

/**
 * Aggregate tasks by hub project (see `domain/work-target.ts`), keyed by
 * `projectId` (so two projects that happen to share a display name are
 * never merged) with the name denormalised alongside for display. Tasks
 * without a `projectId` are grouped under `"(no project)"`.
 */
export function summarizeByProject(tasks: TaskView[]): Map<string, ProjectTotals> {
  const totals = new Map<string, ProjectTotals>();
  for (const task of tasks) {
    const key = task.projectId ?? NO_PROJECT;
    const name = task.projectId !== undefined ? (task.projectName ?? task.projectId) : NO_PROJECT;
    const entry = totals.get(key) ?? { name, wallMs: 0, waitingMs: 0, workMs: 0, cost: 0, count: 0 };
    entry.wallMs += task.wallMs;
    entry.waitingMs += task.waitingMs;
    entry.workMs += task.workMs;
    entry.cost += finiteOrZero(task.usage.cost);
    entry.count += 1;
    totals.set(key, entry);
  }
  return totals;
}

/** Render one line per project, sorted alphabetically by display name, with work/waiting/wall time, cost, and task count. */
export function formatProjects(totals: Map<string, ProjectTotals>): string {
  if (totals.size === 0) return "no projects";
  return Array.from(totals.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (t) =>
        `${t.name}  work ${formatMinutes(t.workMs)}  waiting ${formatMinutes(t.waitingMs)}  wall ${formatMinutes(t.wallMs)}  ${formatCost(t.cost)}  tasks ${t.count}`,
    )
    .join("\n");
}

/** Render one line per client, sorted alphabetically, with work/waiting/wall time, cost, and task count. */
export function formatClients(totals: Map<string, ClientTotals>): string {
  if (totals.size === 0) return "no clients";
  return Array.from(totals.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([client, t]) =>
        `${client}  work ${formatMinutes(t.workMs)}  waiting ${formatMinutes(t.waitingMs)}  wall ${formatMinutes(t.wallMs)}  ${formatCost(t.cost)}  tasks ${t.count}`,
    )
    .join("\n");
}

/** Render one line per session: truncated id, time range, union-based wall/work, cost, non-zero segment tags, and task count. */
export function formatSessions(sessions: SessionView[]): string {
  if (sessions.length === 0) return "no sessions";
  return sessions
    .map((session) => {
      const segmentTags = formatSegmentTags(session.segments);
      const segmentPart = segmentTags !== undefined ? `  ${segmentTags}` : "";
      return `${session.sessionId.slice(0, 8)}  ${formatTime(session.startedAt)}–${formatTime(session.endedAt)}  wall ${formatMinutes(session.wallMs)}  work ${formatMinutes(session.workMs)}  ${formatCost(session.usage.cost)}${segmentPart}  tasks ${session.tasks.length}`;
    })
    .join("\n");
}
