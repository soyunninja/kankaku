import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessions, buildTasks, orphanSubagents, sumUsage, uncertainRecords } from "../src/domain/task-view.ts";
import type { UsageTotals, WorkRecord } from "../src/domain/work-record.ts";

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

test("buildTasks sums a segment tag literally named '__proto__' or 'constructor' as an own property, not as an inherited read", () => {
  // A hand-edited worklog line is free text; nothing stops a tag named
  // after a plain-object prototype property. Parse the way `readAll()`
  // actually would (JSON.parse creates a real own "__proto__" property,
  // unlike the `{ __proto__: ... }` object-literal shorthand) so this
  // exercises the same shape a malicious/careless worklog line would.
  const maliciousSegments: Record<string, number> = JSON.parse('{"__proto__":3000,"constructor":2000}');
  const parent = makeRecord({
    id: "p3",
    pid: 400,
    parentPid: 1,
    startedAt: iso(0),
    settledAt: iso(10),
    segments: maliciousSegments,
  });

  const tasks = buildTasks([parent]);

  assert.deepEqual(tasks[0]!.segments, JSON.parse('{"__proto__":3000,"constructor":2000}'));
  assert.equal(Object.getPrototypeOf(tasks[0]!.segments), Object.prototype); // the returned object's own prototype is untouched
});

test("sumUsage treats a record lacking usage as empty usage", () => {
  const totals: Array<UsageTotals | undefined> = [
    undefined,
    { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
  ];

  const result = sumUsage(totals);

  assert.deepEqual(result, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5 });
});

test("sumUsage treats missing or non-finite numeric fields on a total as zero", () => {
  const totals = [
    { input: 1, cacheRead: 0, cacheWrite: Number.NaN, cost: 0.1 } as unknown as UsageTotals,
  ];

  const result = sumUsage(totals);

  assert.deepEqual(result, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1 });
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

test("buildTasks exposes the orchestrator's client and sessionName on the task", () => {
  const parent = makeRecord({ id: "p1", pid: 100, parentPid: 1, client: "acme", sessionName: "billing sprint" });

  const tasks = buildTasks([parent]);

  assert.equal(tasks[0]!.client, "acme");
  assert.equal(tasks[0]!.sessionName, "billing sprint");
});

test("buildTasks leaves client and sessionName undefined when the orchestrator has neither", () => {
  const parent = makeRecord({ id: "p1", pid: 100, parentPid: 1 });

  const tasks = buildTasks([parent]);

  assert.equal(tasks[0]!.client, undefined);
  assert.equal(tasks[0]!.sessionName, undefined);
  assert.equal("client" in tasks[0]!, false);
});

test("buildTasks exposes the orchestrator's sessionDir when it carries a non-default one", () => {
  const parent = makeRecord({ id: "p1", pid: 100, parentPid: 1, sessionDir: "/custom/session/dir" });

  const tasks = buildTasks([parent]);

  assert.equal(tasks[0]!.sessionDir, "/custom/session/dir");
});

test("buildTasks leaves sessionDir undefined (and omitted) when the orchestrator used the default session dir", () => {
  const parent = makeRecord({ id: "p1", pid: 100, parentPid: 1 });

  const tasks = buildTasks([parent]);

  assert.equal(tasks[0]!.sessionDir, undefined);
  assert.equal("sessionDir" in tasks[0]!, false);
});

test("buildTasks does not inherit client from a subagent child, only from the orchestrator", () => {
  const parent = makeRecord({ id: "p1", pid: 100, parentPid: 1, client: "acme" });
  const child = makeRecord({ id: "c1", role: "subagent", pid: 200, parentPid: 100, startedAt: iso(2), settledAt: iso(5) });

  const tasks = buildTasks([parent, child]);

  assert.equal(tasks[0]!.client, "acme");
  assert.equal(tasks[0]!.subagents[0]?.client, undefined);
});

test("buildTasks exposes the orchestrator's hub clientId/clientName/projectId/projectName on the task", () => {
  const parent = makeRecord({
    id: "p1",
    pid: 100,
    parentPid: 1,
    clientId: "c-acme",
    clientName: "Acme",
    projectId: "p-portal",
    projectName: "Portal",
  });

  const tasks = buildTasks([parent]);

  assert.equal(tasks[0]!.clientId, "c-acme");
  assert.equal(tasks[0]!.clientName, "Acme");
  assert.equal(tasks[0]!.projectId, "p-portal");
  assert.equal(tasks[0]!.projectName, "Portal");
});

test("buildTasks leaves hub fields undefined when the orchestrator has none, and does not inherit them from a subagent child", () => {
  const parent = makeRecord({ id: "p1", pid: 100, parentPid: 1 });
  const child = makeRecord({
    id: "c1",
    role: "subagent",
    pid: 200,
    parentPid: 100,
    startedAt: iso(2),
    settledAt: iso(5),
    clientId: "c-acme",
    clientName: "Acme",
  });

  const tasks = buildTasks([parent, child]);

  assert.equal(tasks[0]!.clientId, undefined);
  assert.equal("clientId" in tasks[0]!, false);
});

// --- SUBAGENT-REQ-013/014: uncertain records never anchor a task ---

test("buildTasks excludes an orchestrator-role record flagged roleConfidence 'uncertain' (SUBAGENT-REQ-013, SUBAGENT-REQ-014)", () => {
  const confirmed = makeRecord({ id: "p1", pid: 100, parentPid: 1 });
  const uncertain = makeRecord({ id: "p2", pid: 101, parentPid: 1, roleConfidence: "uncertain" });

  const tasks = buildTasks([confirmed, uncertain]);

  assert.deepEqual(
    tasks.map((t) => t.id),
    ["p1"],
  );
});

test("uncertainRecords surfaces uncertain orchestrator records without dropping them (SUBAGENT-REQ-017)", () => {
  const confirmed = makeRecord({ id: "p1", pid: 100, parentPid: 1 });
  const uncertain = makeRecord({ id: "p2", pid: 101, parentPid: 1, roleConfidence: "uncertain" });

  assert.deepEqual(
    uncertainRecords([confirmed, uncertain]).map((r) => r.id),
    ["p2"],
  );
});

test("an uncertain record's subagent-role child (if any) is not attached to it and stays an orphan, since it never anchors a task", () => {
  const uncertain = makeRecord({ id: "p2", pid: 101, parentPid: 1, roleConfidence: "uncertain" });
  const child = makeRecord({ id: "c1", role: "subagent", pid: 202, parentPid: 101, startedAt: iso(1), settledAt: iso(5) });

  const tasks = buildTasks([uncertain, child]);
  assert.equal(tasks.length, 0);

  const orphans = orphanSubagents([uncertain, child]);
  assert.deepEqual(
    orphans.map((r) => r.id),
    ["c1"],
  );
});

// --- SUBAGENT-REQ-007/008: project is a hint, never a hard filter ---

test("a gentle-pi cross-worktree child (different project, matching pid/parentPid/time) is reunited with its orchestrator once both records are in the same array (SUBAGENT-REQ-007, SUBAGENT-REQ-008)", () => {
  // In practice the cross-worktree child's record only reaches this array
  // via the registry-corroborated merge (adapters/registry-aware-work-log.ts);
  // matchChildren itself stays pure and just needs project to stop being a
  // hard filter.
  const orchestrator = makeRecord({ id: "orch", pid: 100, parentPid: 1, project: "/worktree-a", startedAt: iso(0), settledAt: iso(30) });
  const child = makeRecord({
    id: "child",
    role: "subagent",
    pid: 200,
    parentPid: 100,
    project: "/worktree-b",
    startedAt: iso(5),
    settledAt: iso(40),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.05 },
  });

  const tasks = buildTasks([orchestrator, child]);

  assert.equal(tasks.length, 1);
  const task = tasks[0]!;
  assert.equal(task.subagents.length, 1);
  assert.equal(task.subagents[0]?.id, "child");
  // Hand-computed union of [0,30] and [5,40] = [0,40] -> 40s.
  assert.equal(task.wallMs, 40000);
  assert.equal(task.usage.cost, 0.05); // summed once, not double-counted
});

test("a same-project candidate is preferred over a cross-project one when both match pid/time (project as a hint, SUBAGENT-REQ-008)", () => {
  const child = makeRecord({ id: "child", role: "subagent", pid: 700, parentPid: 600, project: "/same", startedAt: iso(5), settledAt: iso(6) });
  const sameProjectParent = makeRecord({ id: "same", pid: 600, parentPid: 1, project: "/same", startedAt: iso(0), settledAt: iso(10) });
  const crossProjectParent = makeRecord({ id: "cross", pid: 600, parentPid: 1, project: "/other", startedAt: iso(0), settledAt: iso(10) });

  const tasks = buildTasks([sameProjectParent, crossProjectParent, child]);

  const sameTask = tasks.find((t) => t.id === "same")!;
  const crossTask = tasks.find((t) => t.id === "cross")!;
  assert.equal(sameTask.subagents.length, 1);
  assert.equal(crossTask.subagents.length, 0);
});

test("two unrelated top-level orchestrator sessions in the same repo, overlapping in time, are never joined (SUBAGENT-REQ-007, SUBAGENT-REQ-008)", () => {
  const terminalA = makeRecord({ id: "a", pid: 100, parentPid: 1, project: "/repo", startedAt: iso(0), settledAt: iso(100) });
  const terminalB = makeRecord({ id: "b", pid: 200, parentPid: 1, project: "/repo", startedAt: iso(10), settledAt: iso(90) });

  const tasks = buildTasks([terminalA, terminalB]);

  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((t) => t.subagents.length),
    [0, 0],
  );
});
