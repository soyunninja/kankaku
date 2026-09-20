import assert from "node:assert/strict";
import { test } from "node:test";
import { RegistryAwareWorkLog } from "../src/adapters/registry-aware-work-log.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";
import type { ProcessRegistry, RegistryEntry } from "../src/ports/process-registry.ts";
import type { WorkLog } from "../src/ports/work-log.ts";

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/proj",
    prompt: "prompt",
    startedAt: "2026-09-10T16:00:00.000Z",
    settledAt: "2026-09-10T16:00:10.000Z",
    wallMs: 10000,
    waitingMs: 0,
    workMs: 10000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    status: "completed",
    ...overrides,
  };
}

function fakeLog(records: WorkRecord[]): WorkLog {
  return {
    append: () => {},
    readAll: () => records,
  };
}

function fakeRegistry(entries: RegistryEntry[]): ProcessRegistry {
  return {
    record: () => {},
    readAll: () => entries,
  };
}

const orchestrator = makeRecord({ id: "orch", pid: 100, parentPid: 1, project: "/worktree-a", startedAt: "2026-09-10T16:00:00.000Z", settledAt: "2026-09-10T16:00:30.000Z" });

test("readAll returns local records unchanged when there is no confirmed local orchestrator", () => {
  const log = new RegistryAwareWorkLog({
    inner: fakeLog([]),
    registry: fakeRegistry([]),
    readForeignRecords: () => [],
  });
  assert.deepEqual(log.readAll(), []);
});

test("readAll merges in a foreign subagent record whose orchestratorRef exactly matches a local confirmed orchestrator (SUBAGENT-REQ-007/008/009)", () => {
  const foreignChild = makeRecord({
    id: "child",
    role: "subagent",
    pid: 200,
    parentPid: 100,
    project: "/worktree-b",
    startedAt: "2026-09-10T16:00:05.000Z",
    settledAt: "2026-09-10T16:00:40.000Z",
    orchestratorRef: { pid: 100, project: "/worktree-a", startedAt: "2026-09-10T16:00:00.000Z" },
  });

  const registryEntry: RegistryEntry = {
    pid: 200,
    parentPid: 100,
    role: "subagent",
    project: "/worktree-b",
    dir: "/worktree-b/.kankaku",
    startedAt: "2026-09-10T16:00:05.000Z",
    orchestratorRef: { pid: 100, project: "/worktree-a", startedAt: "2026-09-10T16:00:00.000Z" },
  };

  const log = new RegistryAwareWorkLog({
    inner: fakeLog([orchestrator]),
    registry: fakeRegistry([registryEntry]),
    readForeignRecords: (dir) => (dir === "/worktree-b/.kankaku" ? [foreignChild] : []),
  });

  const all = log.readAll();
  assert.equal(all.length, 2);
  assert.ok(all.some((r) => r.id === "child"));
});

test("readAll does not merge a registry entry whose orchestratorRef points at a different orchestrator identity", () => {
  const registryEntry: RegistryEntry = {
    pid: 200,
    parentPid: 100,
    role: "subagent",
    project: "/worktree-b",
    dir: "/worktree-b/.kankaku",
    startedAt: "2026-09-10T16:00:05.000Z",
    orchestratorRef: { pid: 999, project: "/unrelated", startedAt: "2026-09-01T00:00:00.000Z" },
  };

  const log = new RegistryAwareWorkLog({
    inner: fakeLog([orchestrator]),
    registry: fakeRegistry([registryEntry]),
    readForeignRecords: () => {
      throw new Error("should never be called for a non-matching entry");
    },
  });

  assert.deepEqual(log.readAll(), [orchestrator]);
});

test("readAll does not merge a same-project registry entry (already visible locally, no need to read a foreign file)", () => {
  const registryEntry: RegistryEntry = {
    pid: 200,
    parentPid: 100,
    role: "subagent",
    project: "/worktree-a", // same as orchestrator.project
    dir: "/worktree-a/.kankaku",
    startedAt: "2026-09-10T16:00:05.000Z",
    orchestratorRef: { pid: 100, project: "/worktree-a", startedAt: "2026-09-10T16:00:00.000Z" },
  };

  const log = new RegistryAwareWorkLog({
    inner: fakeLog([orchestrator]),
    registry: fakeRegistry([registryEntry]),
    readForeignRecords: () => {
      throw new Error("should never read a same-project entry's foreign file");
    },
  });

  assert.deepEqual(log.readAll(), [orchestrator]);
});

test("readAll never merges a record from an uncertain-flagged local orchestrator", () => {
  const uncertainOrchestrator = makeRecord({ id: "orch2", pid: 500, parentPid: 1, roleConfidence: "uncertain" });
  const registryEntry: RegistryEntry = {
    pid: 600,
    parentPid: 500,
    role: "subagent",
    project: "/worktree-b",
    dir: "/worktree-b/.kankaku",
    startedAt: "2026-09-10T16:00:00.000Z",
    orchestratorRef: { pid: 500, project: "/proj", startedAt: "2026-09-10T16:00:00.000Z" },
  };

  const log = new RegistryAwareWorkLog({
    inner: fakeLog([uncertainOrchestrator]),
    registry: fakeRegistry([registryEntry]),
    readForeignRecords: () => {
      throw new Error("should never be called for an uncertain orchestrator");
    },
  });

  assert.deepEqual(log.readAll(), [uncertainOrchestrator]);
});

test("readAll tolerates a registry read failure, falling back to local records only", () => {
  const log = new RegistryAwareWorkLog({
    inner: fakeLog([orchestrator]),
    registry: {
      record: () => {},
      readAll: () => {
        throw new Error("registry unavailable");
      },
    },
    readForeignRecords: () => [],
  });

  assert.deepEqual(log.readAll(), [orchestrator]);
});

test("readAll tolerates a readForeignRecords failure for one entry, still returning local records", () => {
  const registryEntry: RegistryEntry = {
    pid: 200,
    parentPid: 100,
    role: "subagent",
    project: "/worktree-b",
    dir: "/worktree-b/.kankaku",
    startedAt: "2026-09-10T16:00:05.000Z",
    orchestratorRef: { pid: 100, project: "/worktree-a", startedAt: "2026-09-10T16:00:00.000Z" },
  };

  const log = new RegistryAwareWorkLog({
    inner: fakeLog([orchestrator]),
    registry: fakeRegistry([registryEntry]),
    readForeignRecords: () => {
      throw new Error("disk error");
    },
  });

  assert.deepEqual(log.readAll(), [orchestrator]);
});

test("readAll never duplicates a record already present locally (dedupe by id)", () => {
  const child = makeRecord({ id: "child", role: "subagent", pid: 200, parentPid: 100, project: "/worktree-a" });
  const registryEntry: RegistryEntry = {
    pid: 200,
    parentPid: 100,
    role: "subagent",
    project: "/worktree-a",
    dir: "/worktree-a/.kankaku",
    startedAt: "2026-09-10T16:00:05.000Z",
    orchestratorRef: { pid: 100, project: "/worktree-a", startedAt: "2026-09-10T16:00:00.000Z" },
  };

  const log = new RegistryAwareWorkLog({
    inner: fakeLog([orchestrator, child]),
    registry: fakeRegistry([registryEntry]),
    readForeignRecords: () => [child],
  });

  assert.equal(log.readAll().length, 2);
});

test("append and version delegate straight through to the inner log", () => {
  let appended: WorkRecord | undefined;
  const inner: WorkLog = {
    append: (record) => {
      appended = record;
    },
    readAll: () => [],
    version: () => "v1",
  };
  const log = new RegistryAwareWorkLog({ inner, registry: fakeRegistry([]), readForeignRecords: () => [] });

  log.append(orchestrator);
  assert.equal(appended?.id, "orch");
  assert.equal(log.version(), "v1");
});
