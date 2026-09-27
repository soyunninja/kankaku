/**
 * Shared line-building for the hub-facing `/kankaku` subcommands (`sync`,
 * `sync all`, `sync status`, `backfill`, `catalog refresh`, `assign`) and
 * the panel's `sync`/`export` screens (`adapters/panel/screens/sync.ts`),
 * extracted from `kankaku-command.ts` so the subcommands and the panel can
 * never drift — see odd/tasks/kankaku-panel.md P4.
 */
import type { HubAssignResolution } from "../domain/hub-assign.ts";
import type { Client, Project } from "../domain/work-target.ts";
import type { CatalogSnapshot } from "../ports/catalog.ts";
import type { SyncedTaskEntryRow } from "./hub-assign.ts";
import type { SyncCommandDeps } from "./kankaku-command.ts";
import type { SyncSummary } from "./sync-runner.ts";

/**
 * `/kankaku sync status`'s report lines: the watermark, the pending count,
 * how many tasks fell outside this run's revisit window (R3), and the last
 * error, when any. Exact body of `handleSyncCommand`'s `status` branch.
 */
export function buildSyncStatusLines(status: ReturnType<SyncCommandDeps["status"]>): string[] {
  const { state, pending, staleOutsideWindow } = status;
  const lines = [state?.syncedThrough ? `synced through ${state.syncedThrough}` : "never synced", `pending: ${pending}`];
  if (staleOutsideWindow > 0) {
    lines.push(`${staleOutsideWindow} task(s) never synced fall outside the sync window — run '/kankaku sync all' to upload them`);
  }
  if (state?.lastError) lines.push(`last error: ${state.lastError.message} (at ${state.lastError.at})`);
  return lines;
}

/**
 * Render a {@link SyncSummary} as report lines: counts, any stop reason, the
 * new watermark, and the unassigned/failed breakdowns. Used by `/kankaku
 * sync`/`sync all` and the panel's sync screen.
 */
export function formatSyncSummaryLines(summary: SyncSummary): string[] {
  const lines = [`uploaded ${summary.uploaded}, updated ${summary.updated}, skipped ${summary.skipped}, failed ${summary.failed.length}`];

  if (summary.locked) lines.push("another sync is already in progress; nothing was attempted");
  if (summary.error) lines.push(`stopped early: ${summary.error}`);
  if (summary.syncedThrough) lines.push(`synced through ${summary.syncedThrough}`);

  const unassignedEntries = Object.entries(summary.unassigned).sort(([a], [b]) => a.localeCompare(b));
  if (unassignedEntries.length > 0) {
    lines.push("unassigned (Sin determinar):");
    for (const [label, count] of unassignedEntries) lines.push(`  ${label}: ${count}`);
  }

  if (summary.failed.length > 0) {
    lines.push("failed:");
    for (const entry of summary.failed) lines.push(`  ${entry.id}: ${entry.reason}`);
  }

  return lines;
}

/**
 * `/kankaku backfill`'s report lines: tasks routed to Sin determinar this
 * run, grouped by their old free-text label, or "no unassigned tasks" when
 * none were. Exact body of `handleBackfillCommand`.
 */
export function formatBackfillLines(summary: SyncSummary): string[] {
  const unassignedEntries = Object.entries(summary.unassigned).sort(([a], [b]) => a.localeCompare(b));

  const lines =
    unassignedEntries.length > 0
      ? [
          ...unassignedEntries.map(([label, count]) => `${label}: ${count} task(s) -> Sin determinar`),
          "reassign these in the hub web app's unassigned queue",
        ]
      : ["no unassigned tasks"];

  if (summary.error) lines.push(`stopped early: ${summary.error}`);
  return lines;
}

/**
 * `/kankaku catalog refresh`'s report lines: client/project counts, or an
 * unreachable notice when the refresh failed (`snapshot` is `undefined`).
 * The subcommand still notifies that failure as an error rather than a
 * report (see `handleCatalogCommand`); the panel's sync screen shows
 * whatever this returns either way.
 */
export function formatCatalogRefreshLines(snapshot: CatalogSnapshot | undefined): string[] {
  if (!snapshot) return ["hub unreachable; catalog not refreshed"];
  return [`refreshed: ${snapshot.clients.length} client(s), ${snapshot.projects.length} project(s)`];
}

/** Longest prompt fragment shown in an assign selector label, before the ellipsis. */
const ASSIGN_PROMPT_LIMIT = 60;

/**
 * `/kankaku assign`'s one-line label for a synced `task_entries` row —
 * `<n>. <started_at> — <client> · <project> — <prompt> [<task_id>]` — used by
 * the subcommand's own `ctx.ui.select` and by a panel screen that lists the
 * same rows. `client`/`project` on the row are relation ids, so they are
 * resolved to names through the catalog snapshot when possible and fall back
 * to the raw id otherwise; the trailing `[task_id]` keeps every label unique
 * (so a label can be mapped back to exactly one row) and gives the user the
 * exact id the direct form accepts. Shared here so the two callers can never
 * drift, exactly like the other report line builders in this module.
 */
export function formatAssignRowLabel(row: SyncedTaskEntryRow, position: number, snapshot?: CatalogSnapshot): string {
  const client = row.client !== undefined ? snapshot?.clients.find((candidate) => candidate.id === row.client) : undefined;
  const project = row.project !== undefined ? snapshot?.projects.find((candidate) => candidate.id === row.project) : undefined;
  const clientLabel = client ? client.name : row.client;
  const projectLabel = project ? project.name : row.project;
  const target =
    clientLabel !== undefined ? (projectLabel !== undefined ? `${clientLabel} · ${projectLabel}` : clientLabel) : "unassigned";

  const segments = [`${position}. ${row.startedAt ?? "unknown"}`, target];
  if (row.prompt !== undefined && row.prompt !== "") {
    segments.push(row.prompt.length > ASSIGN_PROMPT_LIMIT ? `${row.prompt.slice(0, ASSIGN_PROMPT_LIMIT)}…` : row.prompt);
  }
  return `${segments.join(" — ")} [${row.taskId}]`;
}

/**
 * `/kankaku assign`'s success lines: which row was moved to which
 * client/project. Shared with a future panel screen for the same outcome.
 */
export function formatAssignResultLines(input: { taskId: string; client: Client; project?: Project }): string[] {
  const { client, project } = input;
  const target = project ? `${client.name} (${client.code}) · ${project.name}` : `${client.name} (${client.code})`;
  return [`assigned ${input.taskId} to ${target}`];
}

/**
 * The `(no project)` entry in `/kankaku assign`'s interactive project
 * picker — the explicit choice that clears the row's project relation.
 * Shared so the panel's assign screen offers the exact same label as the
 * subcommand (see `adapters/panel/screens/assign.ts`).
 */
export const ASSIGN_NO_PROJECT_LABEL = "(no project)";

/**
 * User-facing wording for a failed `domain/hub-assign.ts#resolveHubAssignment`,
 * in the same style as the neighbouring `/kankaku client`/`target` errors.
 * The panel's assign screen resolves its selection through the exact same
 * resolver as the subcommand, so it must report the exact same failures
 * with the exact same words.
 */
export function describeAssignFailure(result: Exclude<HubAssignResolution, { kind: "resolved" }>): string {
  switch (result.kind) {
    case "client-not-found":
      return `unknown client: ${result.reference}`;
    case "project-not-found":
      return `unknown project: ${result.reference}`;
    case "project-not-in-client":
      return `project ${result.reference} does not belong to client ${result.client.name} (${result.client.code})`;
  }
}
