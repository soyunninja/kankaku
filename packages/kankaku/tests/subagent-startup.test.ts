import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSubagentStartup } from "../src/adapters/subagent-startup.ts";
import type { RegistryEntry } from "../src/ports/process-registry.ts";
import type { ProcessRegistry } from "../src/ports/process-registry.ts";
import type { AncestrySnapshot } from "../src/adapters/ancestry.ts";

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid: 100,
    parentPid: 1,
    role: "orchestrator",
    project: "/proj",
    dir: "/proj/.kankaku",
    startedAt: "2026-09-10T16:00:00.000Z",
    processStartId: 1_757_000_000_000,
    ...overrides,
  };
}

function fakeRegistry(entries: RegistryEntry[]): ProcessRegistry {
  return {
    record: () => {},
    readAll: () => entries,
  };
}

test("F5: never takes an ancestry snapshot when the registry has no other entries at all (the common top-level case)", () => {
  let snapshotCalls = 0;
  const snapshotAncestry = (): AncestrySnapshot => {
    snapshotCalls++;
    return { ppidByPid: new Map(), startIdByPid: new Map() };
  };

  const result = resolveSubagentStartup({
    registry: fakeRegistry([]),
    ppid: 999,
    now: () => 1_757_000_010_000,
    uptimeSeconds: () => 10,
    snapshotAncestry,
  });

  assert.equal(snapshotCalls, 0);
  assert.equal(result.ancestorEntry, undefined);
  assert.deepEqual(result.registryEntries, []);
});

test("F5: takes exactly one ancestry snapshot when other registry entries exist that could be an ancestor", () => {
  let snapshotCalls = 0;
  const parent = entry({ pid: 50 });
  const snapshotAncestry = (): AncestrySnapshot => {
    snapshotCalls++;
    return { ppidByPid: new Map([[999, 50]]), startIdByPid: new Map([[50, parent.processStartId!]]) };
  };

  const result = resolveSubagentStartup({
    registry: fakeRegistry([parent]),
    ppid: 999,
    now: () => 1_757_000_010_000,
    uptimeSeconds: () => 10,
    snapshotAncestry,
  });

  assert.equal(snapshotCalls, 1);
  assert.equal(result.ancestorEntry, parent);
});

test("derives this process's own start id from now-minus-uptime, with no spawn, regardless of whether a snapshot is taken", () => {
  const result = resolveSubagentStartup({
    registry: fakeRegistry([]),
    ppid: 999,
    now: () => 1_757_000_010_000,
    uptimeSeconds: () => 10,
  });

  assert.equal(result.ownProcessStartId, 1_757_000_000_000);
});

test("walks past an untracked hop to find a further verified ancestor", () => {
  const grandparent = entry({ pid: 30 });
  const snapshotAncestry = (): AncestrySnapshot => ({
    ppidByPid: new Map([
      [999, 50],
      [50, 30],
    ]),
    startIdByPid: new Map([[30, grandparent.processStartId!]]),
  });

  const result = resolveSubagentStartup({
    registry: fakeRegistry([grandparent]),
    ppid: 999,
    now: () => 0,
    uptimeSeconds: () => 0,
    snapshotAncestry,
  });

  assert.equal(result.ancestorEntry, grandparent);
});

test("returns undefined ancestorEntry when other entries exist but none are on this process's ancestor chain", () => {
  const unrelated = entry({ pid: 12345 });
  const snapshotAncestry = (): AncestrySnapshot => ({
    ppidByPid: new Map([[999, 50]]),
    startIdByPid: new Map(),
  });

  const result = resolveSubagentStartup({
    registry: fakeRegistry([unrelated]),
    ppid: 999,
    now: () => 0,
    uptimeSeconds: () => 0,
    snapshotAncestry,
  });

  assert.equal(result.ancestorEntry, undefined);
});

test("degrades to no ancestor (never throws) when the registry read itself fails", () => {
  const registry: ProcessRegistry = {
    record: () => {},
    readAll: () => {
      throw new Error("unavailable");
    },
  };

  assert.throws(() => resolveSubagentStartup({ registry, ppid: 999, now: () => 0, uptimeSeconds: () => 0 }));
});
