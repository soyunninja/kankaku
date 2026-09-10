import { buildTasks } from "../domain/task-view.ts";
import type { SessionView, TaskView } from "../domain/task-view.ts";
import type { WorkRecord, WorkRole } from "../domain/work-record.ts";

export interface RoleTotals {
  workMs: number;
  waitingMs: number;
  wallMs: number;
  count: number;
  /** Estimated cost in USD, as priced by pi's model table. */
  cost: number;
}

export interface TaskTotals {
  count: number;
  wallMs: number;
  workMs: number;
  /** Estimated cost in USD, orchestrator and subagents combined. */
  cost: number;
}

export type Summary = Record<WorkRole, RoleTotals> & { tasks: TaskTotals };

export interface SummarizeOptions {
  /** Local day in `YYYY-MM-DD` format. Defaults to today when `all` is not set. */
  day?: string;
  /** Include every record regardless of day. */
  all?: boolean;
}

const ROLES: WorkRole[] = ["orchestrator", "subagent"];

/** Local (not UTC) calendar day of an ISO timestamp, as `YYYY-MM-DD`. */
export function localDay(iso: string): string {
  const date = new Date(iso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyTotals(): RoleTotals {
  return { workMs: 0, waitingMs: 0, wallMs: 0, count: 0, cost: 0 };
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
    tasks: { count: 0, wallMs: 0, workMs: 0, cost: 0 },
  };

  for (const record of records) {
    if (targetDay !== undefined && localDay(record.startedAt) !== targetDay) continue;
    const totals = summary[record.role];
    totals.workMs += record.workMs;
    totals.waitingMs += record.waitingMs;
    totals.wallMs += record.wallMs;
    totals.count += 1;
    totals.cost += record.usage.cost;
  }

  const tasks = buildTasks(records).filter((task) => targetDay === undefined || localDay(task.startedAt) === targetDay);
  for (const task of tasks) {
    summary.tasks.count += 1;
    summary.tasks.wallMs += task.wallMs;
    summary.tasks.workMs += task.workMs;
    summary.tasks.cost += task.usage.cost;
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

/** Render a short, human-readable summary for the `/kankaku` command. */
export function formatReport(summary: Summary): string {
  const lines = ROLES.map((role) => {
    const totals = summary[role];
    return `${role}: work ${formatMinutes(totals.workMs)}, waiting ${formatMinutes(totals.waitingMs)}, ${totals.count} record(s), ${formatCost(totals.cost)}`;
  });
  lines.push(
    `tasks: ${summary.tasks.count}, wall ${formatMinutes(summary.tasks.wallMs)}, work ${formatMinutes(summary.tasks.workMs)}, ${formatCost(summary.tasks.cost)}`,
  );
  return lines.join(" | ");
}

/** Render one line per task: time, union-based wall/work, cost, subagent count, and a truncated prompt. */
export function formatTasks(tasks: TaskView[]): string {
  if (tasks.length === 0) return "no tasks";
  return tasks
    .map((task) => {
      const prompt = task.prompt.length > 60 ? task.prompt.slice(0, 60) : task.prompt;
      return `${formatTime(task.startedAt)}  wall ${formatMinutes(task.wallMs)}  work ${formatMinutes(task.workMs)}  ${formatCost(task.usage.cost)}  subagents ${task.subagents.length}  ${prompt}`;
    })
    .join("\n");
}

/** Render one line per session: truncated id, time range, union-based wall/work, cost, and task count. */
export function formatSessions(sessions: SessionView[]): string {
  if (sessions.length === 0) return "no sessions";
  return sessions
    .map(
      (session) =>
        `${session.sessionId.slice(0, 8)}  ${formatTime(session.startedAt)}–${formatTime(session.endedAt)}  wall ${formatMinutes(session.wallMs)}  work ${formatMinutes(session.workMs)}  ${formatCost(session.usage.cost)}  tasks ${session.tasks.length}`,
    )
    .join("\n");
}
