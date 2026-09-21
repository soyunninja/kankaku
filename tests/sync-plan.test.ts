import assert from "node:assert/strict";
import { test } from "node:test";
import { computeTaskContentHash, planSync, pruneHashes } from "../src/domain/sync-plan.ts";
import type { SyncState } from "../src/domain/sync-plan.ts";
import type { TaskView } from "../src/domain/task-view.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

function iso(secondsFromEpoch: number): string {
  return new Date(secondsFromEpoch * 1000).toISOString();
}

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/proj",
    prompt: "prompt",
    startedAt: iso(0),
    settledAt: iso(10),
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

function makeTask(id: string, startedAtSec: number, endedAtSec: number, overrides: Partial<TaskView> = {}): TaskView {
  const orchestrator = makeRecord({ id, startedAt: iso(startedAtSec), settledAt: iso(endedAtSec) });
  return {
    id,
    project: "/proj",
    prompt: "prompt",
    startedAt: iso(startedAtSec),
    endedAt: iso(endedAtSec),
    wallMs: (endedAtSec - startedAtSec) * 1000,
    waitingMs: 0,
    workMs: (endedAtSec - startedAtSec) * 1000,
    status: "completed",
    orchestrator,
    subagents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    segments: {},
    ...overrides,
  };
}

const TARGET = "https://pb.example.com";

test("with no state, every task is eligible and in toSync (full sync)", () => {
  const tasks = [makeTask("a", 0, 10), makeTask("b", 20, 30)];
  const plan = planSync(tasks, undefined, { target: TARGET });
  assert.equal(plan.isFullSync, true);
  assert.deepEqual(
    plan.toSync.map((t) => t.id),
    ["a", "b"],
  );
  assert.equal(plan.unchangedCount, 0);
});

test("a state synced against a different hub URL triggers a full sync", () => {
  const tasks = [makeTask("a", 0, 10)];
  const state: SyncState = { target: "https://other.example.com", hashes: { a: "stale-hash-from-another-hub" } };
  const plan = planSync(tasks, state, { target: TARGET });
  assert.equal(plan.isFullSync, true);
  assert.deepEqual(
    plan.toSync.map((t) => t.id),
    ["a"],
  );
});

test("options.full forces every task to be evaluated even with matching state", () => {
  const tasks = [makeTask("a", 0, 10)];
  const state: SyncState = { target: TARGET, syncedThrough: iso(10), hashes: { a: computeTaskContentHash(tasks[0]!) } };
  const plan = planSync(tasks, state, { target: TARGET, full: true });
  assert.equal(plan.isFullSync, true);
  // still hash-filtered: unchanged, so not in toSync even on a full sync.
  assert.deepEqual(plan.toSync, []);
  assert.equal(plan.unchangedCount, 1);
});

test("outside a full sync, only tasks ended after syncedThrough - window are eligible", () => {
  const oldTask = makeTask("old", 0, 10); // ended at t=10s
  const recentTask = makeTask("recent", 100000, 100010); // ended well within the window
  const tasks = [oldTask, recentTask];

  // syncedThrough far in the future relative to oldTask, window 1 hour.
  const state: SyncState = { target: TARGET, syncedThrough: iso(100020), hashes: {} };
  const plan = planSync(tasks, state, { target: TARGET, windowHours: 1 });

  assert.equal(plan.isFullSync, false);
  assert.deepEqual(
    plan.toSync.map((t) => t.id),
    ["recent"],
  );
});

test("a task whose stored hash matches its current content is skipped without being in toSync", () => {
  const task = makeTask("a", 0, 10);
  const hash = computeTaskContentHash(task);
  const state: SyncState = { target: TARGET, syncedThrough: iso(20), hashes: { a: hash } };
  const plan = planSync([task], state, { target: TARGET, windowHours: 24 });
  assert.deepEqual(plan.toSync, []);
  assert.equal(plan.unchangedCount, 1);
});

test("a late subagent that changes the task's content produces a different hash, so the task is re-included", () => {
  const before = makeTask("a", 0, 10);
  const beforeHash = computeTaskContentHash(before);

  const after = makeTask("a", 0, 10, { wallMs: 99999, endedAt: iso(99) });
  const state: SyncState = { target: TARGET, syncedThrough: iso(100), hashes: { a: beforeHash } };
  const plan = planSync([after], state, { target: TARGET, windowHours: 1000 });

  assert.deepEqual(
    plan.toSync.map((t) => t.id),
    ["a"],
  );
});

test("a task never synced before (no hash entry) is always in toSync even inside the window", () => {
  const task = makeTask("new", 50, 60);
  const state: SyncState = { target: TARGET, syncedThrough: iso(60), hashes: {} };
  const plan = planSync([task], state, { target: TARGET });
  assert.deepEqual(
    plan.toSync.map((t) => t.id),
    ["new"],
  );
});

test("R3: a late-arriving subagent that bumps a task's endedAt stays inside the revisit window as long as syncedThrough has not advanced past it, however long ago in wall-clock time that was", () => {
  // The orchestrator settled at t=10s and was synced back then (syncedThrough=10s).
  // Its background subagent only settles much later — but nothing else in
  // this directory has synced since, so the watermark never moved. Task
  // views recompute `endedAt` as the max of orchestrator/child settledAt
  // (see task-view.ts), so once the late child is in the log, this task's
  // endedAt jumps forward to the child's settle time.
  const task = makeTask("a", 0, 100_000); // endedAt bumped to the late child's settle time (t=100000s)
  const beforeJoinHash = "stale-hash-from-before-the-child-joined";
  const state: SyncState = { target: TARGET, syncedThrough: iso(10), hashes: { a: beforeJoinHash } };

  const plan = planSync([task], state, { target: TARGET, windowHours: 24 });

  assert.deepEqual(
    plan.toSync.map((t) => t.id),
    ["a"],
    "the task must still be picked up on an ordinary incremental sync — the window is anchored to syncedThrough, not to current wall-clock time",
  );
  assert.deepEqual(plan.staleOutsideWindow, []);
});

test("R3: a late-arriving subagent's task falls outside the revisit window (needs `sync all`) once OTHER activity in the same directory has advanced syncedThrough far enough past it", () => {
  // Same scenario as above, but this time other, unrelated tasks kept
  // syncing in the meantime and pushed the watermark to t=200000s — now
  // more than windowHours behind the late child's own settle time (t=100000s).
  const task = makeTask("a", 0, 100_000);
  const state: SyncState = { target: TARGET, syncedThrough: iso(200_000), hashes: { a: "stale-hash-from-before-the-child-joined" } };

  const plan = planSync([task], state, { target: TARGET, windowHours: 24 });

  assert.deepEqual(plan.toSync, [], "outside the window, an ordinary incremental sync must not re-evaluate the task");
  assert.deepEqual(
    plan.staleOutsideWindow.map((t) => t.id),
    ["a"],
    "but it must be visible as changed-and-outside-the-window, so /kankaku sync status can point at `sync all`",
  );
});

test("R3: staleOutsideWindow never includes a task whose content is actually unchanged, even outside the window", () => {
  const task = makeTask("a", 0, 100_000);
  const hash = computeTaskContentHash(task);
  const state: SyncState = { target: TARGET, syncedThrough: iso(200_000), hashes: { a: hash } };

  const plan = planSync([task], state, { target: TARGET, windowHours: 24 });

  assert.deepEqual(plan.toSync, []);
  assert.deepEqual(plan.staleOutsideWindow, []);
});

test("R3: staleOutsideWindow is always empty on a full sync — nothing is excluded by the window there", () => {
  const task = makeTask("a", 0, 100_000);
  const state: SyncState = { target: TARGET, syncedThrough: iso(200_000), hashes: { a: "stale-hash" } };

  const plan = planSync([task], state, { target: TARGET, windowHours: 24, full: true });

  assert.equal(plan.isFullSync, true);
  assert.deepEqual(
    plan.toSync.map((t) => t.id),
    ["a"],
  );
  assert.deepEqual(plan.staleOutsideWindow, []);
});

test("toSync is sorted chronologically by endedAt", () => {
  const tasks = [makeTask("late", 100, 110), makeTask("early", 0, 10), makeTask("mid", 50, 60)];
  const plan = planSync(tasks, undefined, { target: TARGET });
  assert.deepEqual(
    plan.toSync.map((t) => t.id),
    ["early", "mid", "late"],
  );
});

test("computeTaskContentHash is stable for identical content and changes when a measurement field changes", () => {
  const task = makeTask("a", 0, 10);
  const same = makeTask("a", 0, 10);
  assert.equal(computeTaskContentHash(task), computeTaskContentHash(same));

  const changedCost = makeTask("a", 0, 10, { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 5 } });
  assert.notEqual(computeTaskContentHash(task), computeTaskContentHash(changedCost));
});

test("computeTaskContentHash changes when a session dir change alone triggers a resync", () => {
  const base = makeTask("a", 0, 10);
  const withSessionDir = makeTask("a", 0, 10, { sessionDir: "/custom/dir" });
  assert.notEqual(computeTaskContentHash(base), computeTaskContentHash(withSessionDir));
});

test("computeTaskContentHash changes when a background subagent joins later, flipping subagent_linkage/cost_quality (SUBAGENT-REQ: late join must resync)", () => {
  const orchestratorWithSpan = makeRecord({
    id: "a",
    startedAt: iso(0),
    settledAt: iso(10),
    subagents: [{ toolCallId: "call-1", agent: "reviewer", mode: "task", ms: 1000 }],
  });
  const beforeJoin = makeTask("a", 0, 10, { orchestrator: orchestratorWithSpan });

  const joinedChild = makeRecord({ id: "child-1", role: "subagent", pid: 200, parentPid: 1, costObserved: true });
  const afterJoin = makeTask("a", 0, 10, { orchestrator: orchestratorWithSpan, subagents: [joinedChild] });

  assert.notEqual(computeTaskContentHash(beforeJoin), computeTaskContentHash(afterJoin));
});

test("computeTaskContentHash does not depend on assignment fields (client/project reassignment never triggers a resync by itself)", () => {
  const unassignedTask = makeTask("a", 0, 10);
  const assignedTask = makeTask("a", 0, 10, { clientId: "client-1", projectId: "project-1", clientName: "Acme" });
  assert.equal(computeTaskContentHash(unassignedTask), computeTaskContentHash(assignedTask));
});

test("pruneHashes drops entries for tasks that fell out of the revisit window", () => {
  const oldTask = makeTask("old", 0, 10);
  const recentTask = makeTask("recent", 100000, 100010);
  const hashes = { old: computeTaskContentHash(oldTask), recent: computeTaskContentHash(recentTask) };

  const pruned = pruneHashes(hashes, [oldTask, recentTask], iso(100020), 1);

  assert.deepEqual(Object.keys(pruned), ["recent"]);
});

test("pruneHashes drops entries for task ids no longer present in the task list", () => {
  const recentTask = makeTask("recent", 100000, 100010);
  const hashes = { ghost: "deadbeef", recent: computeTaskContentHash(recentTask) };

  const pruned = pruneHashes(hashes, [recentTask], iso(100020), 24);

  assert.deepEqual(Object.keys(pruned), ["recent"]);
});

test("pruneHashes returns {} when there is no new syncedThrough yet", () => {
  const pruned = pruneHashes({ a: "x" }, [], undefined);
  assert.deepEqual(pruned, {});
});

test("pruneHashes keeps a task id literally named '__proto__' as an own property, not as a silently-dropped prototype write", () => {
  const task = makeTask("__proto__", 100000, 100010);
  const hash = computeTaskContentHash(task);
  // `{ "__proto__": hash }` as an object literal is special-cased by the
  // language itself (it would try to set the prototype, and since `hash`
  // is a string it is silently ignored, never becoming an own property) —
  // build the input the way `JSON.parse` of a stored `sync-state.json`
  // actually would, so this exercises the real shape.
  const hashes: Record<string, string> = JSON.parse(JSON.stringify({ marker: hash }).replace('"marker"', '"__proto__"'));

  const pruned = pruneHashes(hashes, [task], iso(100020), 24);

  assert.deepEqual(Object.keys(pruned), ["__proto__"]);
  assert.equal(pruned["__proto__"], hash);
  assert.equal(Object.getPrototypeOf(pruned), Object.prototype);
});
