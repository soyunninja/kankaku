import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSyncStatusLines, formatBackfillLines, formatCatalogRefreshLines, formatSyncSummaryLines } from "../src/adapters/hub-actions.ts";
import type { SyncSummary } from "../src/adapters/sync-runner.ts";
import type { CatalogSnapshot } from "../src/ports/catalog.ts";

function emptySyncSummary(overrides: Partial<SyncSummary> = {}): SyncSummary {
  return { uploaded: 0, updated: 0, skipped: 0, failed: [], unassigned: {}, syncedThrough: undefined, durationMs: 1, ...overrides };
}

test("buildSyncStatusLines reports 'never synced' and pending when there is no state", () => {
  const lines = buildSyncStatusLines({ state: undefined, pending: 3, staleOutsideWindow: 0 });
  assert.deepEqual(lines, ["never synced", "pending: 3"]);
});

test("buildSyncStatusLines reports the watermark, staleOutsideWindow and last error", () => {
  const lines = buildSyncStatusLines({
    state: { target: "https://pb.example.com", syncedThrough: "2026-09-20T00:00:00.000Z", hashes: {}, lastError: { message: "boom", at: "2026-09-20T01:00:00.000Z" } },
    pending: 4,
    staleOutsideWindow: 2,
  });
  assert.match(lines.join("\n"), /synced through 2026-09-20T00:00:00\.000Z/);
  assert.match(lines.join("\n"), /pending: 4/);
  assert.match(lines.join("\n"), /2 task\(s\) never synced.*outside the sync window/);
  assert.match(lines.join("\n"), /last error: boom \(at 2026-09-20T01:00:00\.000Z\)/);
});

test("formatSyncSummaryLines reports counts, locked/error/watermark, and unassigned/failed breakdowns", () => {
  const summary = emptySyncSummary({
    uploaded: 2,
    updated: 1,
    skipped: 3,
    failed: [{ id: "t1", reason: "network" }],
    unassigned: { cajamar: 2 },
    syncedThrough: "2026-09-25T00:00:00.000Z",
    locked: true,
    error: "network down",
  });

  const lines = formatSyncSummaryLines(summary);
  assert.match(lines[0]!, /uploaded 2, updated 1, skipped 3, failed 1/);
  assert.ok(lines.includes("another sync is already in progress; nothing was attempted"));
  assert.ok(lines.includes("stopped early: network down"));
  assert.ok(lines.includes("synced through 2026-09-25T00:00:00.000Z"));
  assert.ok(lines.includes("unassigned (Sin determinar):"));
  assert.ok(lines.includes("  cajamar: 2"));
  assert.ok(lines.includes("failed:"));
  assert.ok(lines.includes("  t1: network"));
});

test("formatSyncSummaryLines omits optional sections when absent", () => {
  const lines = formatSyncSummaryLines(emptySyncSummary());
  assert.deepEqual(lines, ["uploaded 0, updated 0, skipped 0, failed 0"]);
});

test("formatBackfillLines groups unassigned tasks by their old label and points at the hub web app", () => {
  const summary = emptySyncSummary({ uploaded: 3, unassigned: { cajamar: 2, "otra-empresa": 1 } });
  const lines = formatBackfillLines(summary);
  assert.match(lines.join("\n"), /cajamar: 2 task\(s\) -> Sin determinar/);
  assert.match(lines.join("\n"), /otra-empresa: 1 task\(s\) -> Sin determinar/);
  assert.match(lines.join("\n"), /reassign these in the hub web app/);
});

test("formatBackfillLines reports 'no unassigned tasks' when nothing was routed to Sin determinar", () => {
  assert.deepEqual(formatBackfillLines(emptySyncSummary()), ["no unassigned tasks"]);
});

test("formatBackfillLines appends the stopped-early error when present", () => {
  const lines = formatBackfillLines(emptySyncSummary({ error: "network down" }));
  assert.ok(lines.includes("stopped early: network down"));
});

test("formatCatalogRefreshLines reports client/project counts", () => {
  const snapshot: CatalogSnapshot = {
    fetchedAt: 0,
    url: "https://pb.example.com",
    clients: [
      { id: "c-acme", name: "Acme", code: "acme", active: true },
      { id: "c-globex", name: "Globex", code: "globex", active: true },
    ],
    projects: [{ id: "p-portal", name: "Portal", clientId: "c-acme", repoPaths: [], active: true }],
  };
  const lines = formatCatalogRefreshLines(snapshot);
  assert.match(lines[0]!, /2 client\(s\), 1 project\(s\)/);
});

test("formatCatalogRefreshLines reports unreachable when the refresh failed", () => {
  assert.deepEqual(formatCatalogRefreshLines(undefined), ["hub unreachable; catalog not refreshed"]);
});
