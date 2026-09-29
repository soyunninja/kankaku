import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSyncRows } from "../src/domain/sync-model.ts";
import type { SyncStatusSnapshot } from "kankaku-pi/hub";
import type { ProjectRef } from "../src/ports/project-source.ts";

function project(name: string): ProjectRef {
  return { name, dir: `/work/${name}` };
}

function status(overrides: Partial<SyncStatusSnapshot> = {}): SyncStatusSnapshot {
  return { state: undefined, pending: 0, staleOutsideWindow: 0, ...overrides };
}

test("buildSyncRows maps one row per project, sorted by name", () => {
  const rows = buildSyncRows([
    { project: project("beta"), status: status({ pending: 2 }) },
    { project: project("alpha"), status: status({ pending: 1 }) },
  ]);

  assert.deepEqual(
    rows.map((row) => row.name),
    ["alpha", "beta"],
  );
});

test("buildSyncRows carries pending, staleOutsideWindow, syncedThrough and lastError from the snapshot state", () => {
  const rows = buildSyncRows([
    {
      project: project("alpha"),
      status: status({
        pending: 3,
        staleOutsideWindow: 1,
        state: { target: "https://pb.example.com", hashes: {}, syncedThrough: "2026-09-27T10:00:00.000Z", lastError: { message: "boom", at: "2026-09-27T09:00:00.000Z" } },
      }),
    },
  ]);

  const row = rows[0]!;
  assert.equal(row.dir, "/work/alpha");
  assert.equal(row.pending, 3);
  assert.equal(row.staleOutsideWindow, 1);
  assert.equal(row.syncedThrough, "2026-09-27T10:00:00.000Z");
  assert.deepEqual(row.lastError, { message: "boom", at: "2026-09-27T09:00:00.000Z" });
});

test("buildSyncRows omits syncedThrough/lastError when there is no persisted state yet", () => {
  const rows = buildSyncRows([{ project: project("alpha"), status: status() }]);
  assert.equal(rows[0]?.syncedThrough, undefined);
  assert.equal(rows[0]?.lastError, undefined);
});
