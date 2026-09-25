/**
 * The five `/kankaku` report views (summary/tasks/sessions/clients/
 * projects), each as one pure `WorkRecord[] -> KankakuReportData` builder.
 * Extracted from `kankaku-command.ts`'s subcommand handlers (see
 * odd/tasks/kankaku-panel.md P3) so the `/kankaku` subcommands and the
 * panel's report screen (`panel/screens/report.ts`) always compute the
 * exact same lines — neither ever re-implements the other's logic.
 */
import { buildSessions, buildTasks } from "../domain/task-view.ts";
import type { WorkRecord } from "../domain/work-record.ts";
import type { KankakuReportData } from "./kankaku-command.ts";
import { countUncertain, formatClients, formatProjects, formatReport, formatSessions, formatTasks, localDay, summarize, summarizeByClient, summarizeByProject } from "./report.ts";

/** Shared by every view except `buildTasksView`: `all` includes every day, otherwise only today's local day. */
export interface ReportViewOptions {
  all: boolean;
}

/** `buildTasksView`'s own options: `all` scopes to every session instead of local-day range (tasks are never day-filtered — see `kankaku-command.ts`'s original `tasks` handler). */
export interface TasksViewOptions {
  all: boolean;
  sessionId: string | undefined;
}

/** The plain-text summary view (`/kankaku` with no view token): role/task totals, plus a one-line hint when uncertain records were excluded (SUBAGENT-REQ-017). */
export function buildSummaryView(records: WorkRecord[], options: ReportViewOptions): KankakuReportData {
  const { all } = options;
  const summary = summarize(records, { all });
  const lines = formatReport(summary).split(" | ");
  const uncertainCount = countUncertain(records, { all });
  if (uncertainCount > 0) {
    lines.push(`kankaku: ${uncertainCount} uncertain record(s) excluded from tasks — run /kankaku doctor`);
  }
  return { title: all ? "summary (all days)" : "summary (today)", lines };
}

/** `/kankaku clients [all]`: per-client totals. */
export function buildClientsView(records: WorkRecord[], options: ReportViewOptions): KankakuReportData {
  const { all } = options;
  const today = localDay(new Date().toISOString());
  const tasks = buildTasks(records).filter((task) => all || localDay(task.startedAt) === today);
  return { title: all ? "clients (all days)" : "clients (today)", lines: formatClients(summarizeByClient(tasks)).split("\n") };
}

/** `/kankaku projects [all]`: per-project totals. */
export function buildProjectsView(records: WorkRecord[], options: ReportViewOptions): KankakuReportData {
  const { all } = options;
  const today = localDay(new Date().toISOString());
  const tasks = buildTasks(records).filter((task) => all || localDay(task.startedAt) === today);
  return { title: all ? "projects (all days)" : "projects (today)", lines: formatProjects(summarizeByProject(tasks)).split("\n") };
}

/** `/kankaku sessions [all]`: per-session totals. */
export function buildSessionsView(records: WorkRecord[], options: ReportViewOptions): KankakuReportData {
  const { all } = options;
  const today = localDay(new Date().toISOString());
  const tasks = buildTasks(records).filter((task) => all || localDay(task.startedAt) === today);
  return { title: all ? "sessions (all days)" : "sessions (today)", lines: formatSessions(buildSessions(tasks)).split("\n") };
}

/**
 * `/kankaku tasks [all]`: one line per task. Unlike every other view, tasks
 * are never restricted by local day — `all` (or a missing `sessionId`)
 * instead scopes from "this session" to "every session".
 */
export function buildTasksView(records: WorkRecord[], options: TasksViewOptions): KankakuReportData {
  const { all, sessionId } = options;
  const scoped = all || !sessionId;
  const tasks = buildTasks(records).filter((task) => scoped || task.sessionId === sessionId);
  return { title: scoped ? "tasks (every session)" : "tasks (this session)", lines: formatTasks(tasks).split("\n") };
}
