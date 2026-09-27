import { summarize } from "kankaku/hub";
import type { SyncStatusSnapshot } from "kankaku/hub";
import type { WorkRecord } from "kankaku/domain";
import { buildTodayRows } from "./today-model.ts";
import type { TodayRow } from "./today-model.ts";

export interface DashboardProjectInput {
  name: string;
  records: WorkRecord[];
}

export interface DashboardOptions {
  /** Local day (`YYYY-MM-DD`) treated as "today" — the last point of `last7Days`. Never `Date.now()` here; the caller injects it. */
  today: string;
}

export interface DayPoint {
  /** `YYYY-MM-DD`. */
  day: string;
  /** Three-letter lowercase weekday abbreviation (`mon`, `tue`, …). */
  weekday: string;
  workMs: number;
  cost: number;
}

export interface DashboardProjectRow extends TodayRow {
  /** `workMs / max(workMs)` across today's rows; `0` when every row is zero. */
  share: number;
}

export interface DashboardHubInput {
  name: string;
  status: SyncStatusSnapshot;
}

export interface DashboardHubCatalogSummary {
  url: string;
  clientCount: number;
  projectCount: number;
}

export type DashboardHubCard =
  | { status: "unavailable" }
  | {
      status: "ready";
      pending: number;
      staleOutsideWindow: number;
      lastSyncOk: boolean;
      lastSyncAt?: string;
      catalog?: DashboardHubCatalogSummary;
    };

export interface DashboardModel {
  /** Today's grand total across every project (same shape as `today-model.ts`'s `TodayRow`, reusing its own total row rather than re-aggregating). */
  today: TodayRow;
  /** Exactly 7 points, oldest first, ending on `options.today`. */
  last7Days: DayPoint[];
  /** Today's per-project rows (same set `buildTodayRows` returns), each carrying a `share` for the bar column. */
  projects: DashboardProjectRow[];
  hub: DashboardHubCard;
}

const WEEKDAY_LABELS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** `day` shifted by `deltaDays` (may be negative), as a `YYYY-MM-DD` string. */
function shiftDay(day: string, deltaDays: number): string {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + deltaDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${dayOfMonth}`;
}

function weekdayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  return WEEKDAY_LABELS[date.getDay()] ?? "";
}

/** Sum `workMs`/`cost` across every project for each of the 7 days ending on `today`, via kankaku's own `summarize` per day — never reimplementing its aggregation. */
function buildLast7Days(projects: DashboardProjectInput[], today: string): DayPoint[] {
  const days = Array.from({ length: 7 }, (_, index) => shiftDay(today, index - 6));
  return days.map((day) => {
    let workMs = 0;
    let cost = 0;
    for (const project of projects) {
      const summary = summarize(project.records, { all: false, day });
      workMs += summary.tasks.workMs;
      cost += summary.tasks.cost;
    }
    return { day, weekday: weekdayLabel(day), workMs, cost };
  });
}

/** Attach `share` (`workMs / max workMs`) to each of today's rows. */
function withShare(rows: TodayRow[]): DashboardProjectRow[] {
  const maxWorkMs = rows.reduce((max, row) => Math.max(max, row.workMs), 0);
  return rows.map((row) => ({ ...row, share: maxWorkMs > 0 ? row.workMs / maxWorkMs : 0 }));
}

/**
 * Build the Hub card from per-project {@link SyncStatusSnapshot}s
 * (`computeSyncStatus`, never reimplemented here) and an optional catalog
 * summary. `entries === undefined` means the hub is not configured at
 * all, distinct from a configured-but-empty project list.
 */
function buildHubCard(entries: DashboardHubInput[] | undefined, catalog: DashboardHubCatalogSummary | undefined): DashboardHubCard {
  if (entries === undefined) return { status: "unavailable" };

  let pending = 0;
  let staleOutsideWindow = 0;
  let lastSyncAt: string | undefined;
  let lastSyncOk = true;

  for (const entry of entries) {
    pending += entry.status.pending;
    staleOutsideWindow += entry.status.staleOutsideWindow;
    const syncedThrough = entry.status.state?.syncedThrough;
    if (syncedThrough !== undefined && (lastSyncAt === undefined || syncedThrough > lastSyncAt)) {
      lastSyncAt = syncedThrough;
    }
    if (entry.status.state?.lastError !== undefined) lastSyncOk = false;
  }

  return {
    status: "ready",
    pending,
    staleOutsideWindow,
    lastSyncOk,
    ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
    ...(catalog !== undefined ? { catalog } : {}),
  };
}

/**
 * Build the Today dashboard's model: today's total and per-project rows
 * (`today-model.ts#buildTodayRows`, not reimplemented), the last 7 days'
 * work/cost series, and the Hub card. Pure — every "now" comes from
 * `options.today`, and every hub fact comes from already-resolved inputs.
 */
export function buildDashboardModel(
  projects: DashboardProjectInput[],
  hubEntries: DashboardHubInput[] | undefined,
  catalogSummary: DashboardHubCatalogSummary | undefined,
  options: DashboardOptions,
): DashboardModel {
  const { rows, total } = buildTodayRows(projects, { today: options.today });
  return {
    today: total,
    last7Days: buildLast7Days(projects, options.today),
    projects: withShare(rows),
    hub: buildHubCard(hubEntries, catalogSummary),
  };
}
