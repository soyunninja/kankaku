import { summarize } from "kankaku/hub";
import { cacheHitRatio } from "kankaku/domain";
import type { WorkRecord } from "kankaku/domain";

export interface TodayRow {
  name: string;
  tasks: number;
  wallMs: number;
  workMs: number;
  waitingMs: number;
  cost: number;
  cacheHit?: number;
}

export interface TodayModel {
  rows: TodayRow[];
  total: TodayRow;
}

export interface TodayModelOptions {
  /** Local day (`YYYY-MM-DD`) to restrict rows to. Defaults to today. */
  today?: string;
}

interface ProjectInput {
  name: string;
  records: WorkRecord[];
}

/**
 * Build one {@link TodayRow} per project (via kankaku's own `summarize`,
 * never reimplementing its aggregation) plus a grand total, sorted by
 * `workMs` descending. Projects with no tasks on the target day are
 * dropped. `waitingMs` comes from the role totals (`orchestrator` +
 * `subagent`), since `summarize`'s task totals do not carry it.
 */
export function buildTodayRows(projects: ProjectInput[], options: TodayModelOptions = {}): TodayModel {
  const rows: TodayRow[] = [];
  let totalTasks = 0;
  let totalWallMs = 0;
  let totalWorkMs = 0;
  let totalWaitingMs = 0;
  let totalCost = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  for (const project of projects) {
    const summary = summarize(project.records, { all: false, day: options.today });
    if (summary.tasks.count === 0) continue;

    const waitingMs = summary.orchestrator.waitingMs + summary.subagent.waitingMs;
    rows.push({
      name: project.name,
      tasks: summary.tasks.count,
      wallMs: summary.tasks.wallMs,
      workMs: summary.tasks.workMs,
      waitingMs,
      cost: summary.tasks.cost,
      cacheHit: cacheHitRatio(summary.tasks),
    });

    totalTasks += summary.tasks.count;
    totalWallMs += summary.tasks.wallMs;
    totalWorkMs += summary.tasks.workMs;
    totalWaitingMs += waitingMs;
    totalCost += summary.tasks.cost;
    totalInput += summary.tasks.input;
    totalCacheRead += summary.tasks.cacheRead;
    totalCacheWrite += summary.tasks.cacheWrite;
  }

  rows.sort((a, b) => b.workMs - a.workMs);

  const total: TodayRow = {
    name: "total",
    tasks: totalTasks,
    wallMs: totalWallMs,
    workMs: totalWorkMs,
    waitingMs: totalWaitingMs,
    cost: totalCost,
    cacheHit: cacheHitRatio({ input: totalInput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }),
  };

  return { rows, total };
}

/** Render `<minutes>m` or, once at least an hour, `<hours>h<minutes>m` (minutes zero-padded to two digits). */
export function formatMinutes(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

/** Render `$X.YZ`. */
function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatRow(row: TodayRow): string {
  const cacheHitPart = row.cacheHit !== undefined ? `  cache hit ${Math.round(row.cacheHit * 100)}%` : "";
  return `${row.name}  tasks ${row.tasks}  wall ${formatMinutes(row.wallMs)}  work ${formatMinutes(row.workMs)}  wait ${formatMinutes(row.waitingMs)}  ${formatCost(row.cost)}${cacheHitPart}`;
}

/** Render one aligned line per row, plus a final total line. */
export function formatTodayLines(rows: TodayRow[], total: TodayRow): string[] {
  return [...rows.map(formatRow), formatRow(total)];
}
