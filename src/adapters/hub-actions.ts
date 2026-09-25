/**
 * Shared line-building for the hub-facing `/kankaku` subcommands (`sync`,
 * `sync all`, `sync status`, `backfill`, `catalog refresh`) and the panel's
 * `sync`/`export` screens (`adapters/panel/screens/sync.ts`), extracted from
 * `kankaku-command.ts` so the subcommands and the panel can never drift —
 * see odd/tasks/kankaku-panel.md P4.
 */
import type { CatalogSnapshot } from "../ports/catalog.ts";
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
