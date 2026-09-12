import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessions, buildTasks, orphanSubagents } from "../src/domain/task-view.ts";
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
    sessionId: "session-a",
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

test("background children that outlive the parent extend the task's wallMs by union, not by sum", () => {
  // Mirrors the real worklog: a 33s orchestrator settles while three
  // background subagents (started inside its window) keep running until
  // 27s after it settled.
  const parent = makeRecord({ id: "p1", pid: 100, parentPid: 1, startedAt: iso(0), settledAt: iso(33), wallMs: 33000, waitingMs: 0 });
  const child1 = makeRecord({ id: "c1", role: "subagent", pid: 200, parentPid: 100, startedAt: iso(18), settledAt: iso(34), wallMs: 16000 });
  const child2 = makeRecord({ id: "c2", role: "subagent", pid: 201, parentPid: 100, startedAt: iso(26), settledAt: iso(41), wallMs: 15000 });
  const child3 = makeRecord({ id: "c3", role: "subagent", pid: 202, parentPid: 100, startedAt: iso(26), settledAt: iso(60), wallMs: 34000 });

  const tasks = buildTasks([parent, child1, child2, child3]);

  assert.equal(tasks.length, 1);
  const task = tasks[0]!;
  assert.equal(task.subagents.length, 3);
  assert.equal(task.wallMs, 60000); // union of [0,33] u [18,34] u [26,41] u [26,60] = [0,60]
  assert.notEqual(task.wallMs, 33000 + 16000 + 15000 + 34000);
  assert.equal(task.endedAt, iso(60));
  assert.equal(task.waitingMs, parent.waitingMs);
  assert.equal(task.workMs, task.wallMs - task.waitingMs);
});

test("a task-mode child fully inside the parent window does not extend the task's wallMs", () => {
  const parent = makeRecord({ id: "p2", pid: 300, parentPid: 1, startedAt: iso(100), settledAt: iso(150), wallMs: 50000 });
  const child = makeRecord({ id: "c4", role: "subagent", pid: 301, parentPid: 300, startedAt: iso(110), settledAt: iso(120), wallMs: 10000 });

  const tasks = buildTasks([parent, child]);

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.subagents.length, 1);
  assert.equal(tasks[0]!.wallMs, 50000);
});

test("a subagent record whose parentPid does not match any orchestrator pid is not attached and is reported as an orphan", () => {
  const parent = makeRecord({ id: "p3", pid: 400, parentPid: 1, startedAt: iso(200), settledAt: iso(210) });
  const stray = makeRecord({ id: "c5", role: "subagent", pid: 500, parentPid: 999, startedAt: iso(205), settledAt: iso(207) });

  const tasks = buildTasks([parent, stray]);
  assert.equal(tasks[0]!.subagents.length, 0);

  const orphans = orphanSubagents([parent, stray]);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0]!.id, "c5");
});

test("when a pid is reused, a child attaches to the latest-starting matching parent", () => {
  const parentEarly = makeRecord({ id: "pe", pid: 600, parentPid: 1, startedAt: iso(300), settledAt: iso(400) });
  const parentLate = makeRecord({ id: "pl", pid: 600, parentPid: 1, startedAt: iso(350), settledAt: iso(450) });
  const child = makeRecord({ id: "cx", role: "subagent", pid: 700, parentPid: 600, startedAt: iso(370), settledAt: iso(380) });

  const tasks = buildTasks([parentEarly, parentLate, child]);

  const early = tasks.find((t) => t.id === "pe")!;
  const late = tasks.find((t) => t.id === "pl")!;
  assert.equal(early.subagents.length, 0);
  assert.equal(late.subagents.length, 1);
  assert.equal(late.subagents[0]!.id, "cx");
});

test("buildTasks sorts tasks by startedAt and sums usage across parent and children", () => {
  const parentA = makeRecord({
    id: "pa",
    pid: 800,
    parentPid: 1,
    startedAt: iso(20),
    settledAt: iso(30),
    usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, cost: 0.1 },
  });
  const parentB = makeRecord({
    id: "pb",
    pid: 801,
    parentPid: 1,
    startedAt: iso(0),
    settledAt: iso(10),
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
  });
  const child = makeRecord({
    id: "cb",
    role: "subagent",
    pid: 802,
    parentPid: 801,
    startedAt: iso(5),
    settledAt: iso(9),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
  });

  const tasks = buildTasks([parentA, parentB, child]);

  assert.deepEqual(
    tasks.map((t) => t.id),
    ["pb", "pa"],
  );
  const taskB = tasks.find((t) => t.id === "pb")!;
  assert.deepEqual(taskB.usage, { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.03 });
});

test("buildSessions groups tasks by sessionId into separate session views", () => {
  const taskA = makeRecord({ id: "sa", sessionId: "sess-a", pid: 900, parentPid: 1, startedAt: iso(0), settledAt: iso(10) });
  const taskB = makeRecord({ id: "sb", sessionId: "sess-b", pid: 901, parentPid: 1, startedAt: iso(20), settledAt: iso(25) });

  const tasks = buildTasks([taskA, taskB]);
  const sessions = buildSessions(tasks);

  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((s) => s.sessionId),
    ["sess-a", "sess-b"],
  );
  assert.equal(sessions[0]!.tasks.length, 1);
  assert.equal(sessions[1]!.tasks.length, 1);
});

test("buildSessions groups tasks without a sessionId under 'unknown' and sums waiting/usage", () => {
  const taskA = makeRecord({
    id: "u1",
    sessionId: undefined,
    pid: 1000,
    parentPid: 1,
    startedAt: iso(0),
    settledAt: iso(10),
    waitingMs: 1000,
    usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
  });
  const taskB = makeRecord({
    id: "u2",
    sessionId: undefined,
    pid: 1001,
    parentPid: 1,
    startedAt: iso(20),
    settledAt: iso(35),
    waitingMs: 2000,
    usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
  });

  const tasks = buildTasks([taskA, taskB]);
  const sessions = buildSessions(tasks);

  assert.equal(sessions.length, 1);
  const session = sessions[0]!;
  assert.equal(session.sessionId, "unknown");
  assert.equal(session.waitingMs, 3000);
  assert.equal(session.wallMs, 10000 + 15000); // disjoint task intervals: union == sum here
  assert.equal(session.workMs, session.wallMs - session.waitingMs);
  assert.deepEqual(session.usage, { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.03 });
});

test("buildTasks sums segments across the orchestrator and its children", () => {
  const parent = makeRecord({
    id: "p1",
    pid: 100,
    parentPid: 1,
    startedAt: iso(0),
    settledAt: iso(30),
    segments: { review: 5000 },
  });
  const child = makeRecord({
    id: "c1",
    role: "subagent",
    pid: 200,
    parentPid: 100,
    startedAt: iso(5),
    settledAt: iso(20),
    segments: { review: 2000, commit: 1000 },
  });

  const tasks = buildTasks([parent, child]);

  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0]!.segments, { review: 7000, commit: 1000 });
});

test("buildTasks treats a record without segments (older log line) as {}", () => {
  const parent = makeRecord({ id: "p2", pid: 300, parentPid: 1, startedAt: iso(0), settledAt: iso(10), segments: undefined });

  const tasks = buildTasks([parent]);

  assert.deepEqual(tasks[0]!.segments, {});
});

test("buildSessions sums segments across all of a session's tasks", () => {
  const taskA = makeRecord({
    id: "sa",
    sessionId: "sess-a",
    pid: 900,
    parentPid: 1,
    startedAt: iso(0),
    settledAt: iso(10),
    segments: { review: 1000 },
  });
  const taskB = makeRecord({
    id: "sb",
    sessionId: "sess-a",
    pid: 901,
    parentPid: 1,
    startedAt: iso(20),
    settledAt: iso(25),
    segments: { review: 500, commit: 200 },
  });

  const tasks = buildTasks([taskA, taskB]);
  const sessions = buildSessions(tasks);

  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0]!.segments, { review: 1500, commit: 200 });
});
