import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessions, buildTasks, detectSameProcessOverlaps, orphanSubagents, sumUsage, uncertainRecords } from "../src/domain/task-view.ts";
import type { SubagentSpan, UsageTotals, WorkRecord } from "../src/domain/work-record.ts";

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
  // because F1's write-side routing (extension.ts) wrote it straight into
  // the same worklog.jsonl the orchestrator's own record lives in;
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

// --- SUBAGENT-REQ-015: same-pid overlapping-orchestrator union-not-sum guard (6c) ---

test("SUBAGENT-REQ-015: two confirmed-orchestrator records sharing the same pid with overlapping windows are flagged, wall time unioned via unionMs", () => {
  const first = makeRecord({ id: "a", pid: 555, parentPid: 1, startedAt: iso(0), settledAt: iso(30) });
  const second = makeRecord({ id: "b", pid: 555, parentPid: 1, startedAt: iso(10), settledAt: iso(50) });

  const overlaps = detectSameProcessOverlaps([first, second]);

  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0]?.pid, 555);
  assert.deepEqual(overlaps[0]?.recordIds.sort(), ["a", "b"]);
  // union of [0,30] and [10,50] = [0,50] -> 50s, never the naive sum (30+40=70s).
  assert.equal(overlaps[0]?.unionedWallMs, 50000);
});

test("SUBAGENT-REQ-015: two confirmed-orchestrator records sharing a pid but NOT overlapping in time (e.g. sequential /fork/new sessions) are never flagged", () => {
  const first = makeRecord({ id: "a", pid: 555, parentPid: 1, startedAt: iso(0), settledAt: iso(10) });
  const second = makeRecord({ id: "b", pid: 555, parentPid: 1, startedAt: iso(20), settledAt: iso(30) });

  assert.deepEqual(detectSameProcessOverlaps([first, second]), []);
});

test("SUBAGENT-REQ-015: different pids are never flagged, however much their windows overlap", () => {
  const first = makeRecord({ id: "a", pid: 555, parentPid: 1, startedAt: iso(0), settledAt: iso(30) });
  const second = makeRecord({ id: "b", pid: 556, parentPid: 1, startedAt: iso(10), settledAt: iso(50) });

  assert.deepEqual(detectSameProcessOverlaps([first, second]), []);
});

test("SUBAGENT-REQ-015: an uncertain orchestrator record is never flagged (only CONFIRMED orchestrators participate)", () => {
  const first = makeRecord({ id: "a", pid: 555, parentPid: 1, startedAt: iso(0), settledAt: iso(30) });
  const second = makeRecord({ id: "b", pid: 555, parentPid: 1, startedAt: iso(10), settledAt: iso(50), roleConfidence: "uncertain" });

  assert.deepEqual(detectSameProcessOverlaps([first, second]), []);
});

test("SUBAGENT-REQ-015: a subagent-role record is never flagged, even sharing a pid and overlapping in time with an orchestrator", () => {
  const orchestrator = makeRecord({ id: "a", pid: 555, parentPid: 1, startedAt: iso(0), settledAt: iso(30) });
  const child = makeRecord({ id: "b", role: "subagent", pid: 555, parentPid: 1, startedAt: iso(10), settledAt: iso(50) });

  assert.deepEqual(detectSameProcessOverlaps([orchestrator, child]), []);
});

test("SUBAGENT-REQ-015: three overlapping same-pid orchestrator records are unioned and flagged together", () => {
  const a = makeRecord({ id: "a", pid: 9, parentPid: 1, startedAt: iso(0), settledAt: iso(10) });
  const b = makeRecord({ id: "b", pid: 9, parentPid: 1, startedAt: iso(5), settledAt: iso(15) });
  const c = makeRecord({ id: "c", pid: 9, parentPid: 1, startedAt: iso(12), settledAt: iso(20) });

  const overlaps = detectSameProcessOverlaps([a, b, c]);

  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0]?.recordIds.sort(), ["a", "b", "c"]);
  assert.equal(overlaps[0]?.unionedWallMs, 20000);
});

test("SUBAGENT-REQ-015: detectSameProcessOverlaps never changes buildTasks' own per-task wallMs — plain and gentle-pi runs are unaffected (informational/doctor-only, ADR 0006's aggregation rule stays exactly where it was)", () => {
  const first = makeRecord({ id: "a", pid: 555, parentPid: 1, startedAt: iso(0), settledAt: iso(30) });
  const second = makeRecord({ id: "b", pid: 555, parentPid: 1, startedAt: iso(10), settledAt: iso(50) });

  const tasks = buildTasks([first, second]);

  assert.equal(tasks.length, 2);
  assert.equal(tasks.find((t) => t.id === "a")?.wallMs, 30000);
  assert.equal(tasks.find((t) => t.id === "b")?.wallMs, 40000);
});

// --- C1 (CRITICAL fix): buildTasks reconciles span-level forwardedUsage
// (SUBAGENT-REQ-006 revised) — ADR 0006's "aggregation happens in exactly
// one place" rule applied to the writer-admitted "configured profile with
// both a marker AND usage forwarding" double-count hole. ---

function span(overrides: Partial<SubagentSpan> = {}): SubagentSpan {
  return { toolCallId: "call-1", agent: "researcher", mode: "task", ms: 1000, ...overrides };
}

test("C1: an unambiguous pi-reference span's forwardedUsage is added to the task total when no child was ever joined for it", () => {
  const orchestrator = makeRecord({
    id: "o1",
    pid: 10,
    parentPid: 1,
    startedAt: iso(0),
    settledAt: iso(10),
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
    subagents: [span({ profile: "pi-reference", forwardedUsage: { input: 20, output: 5, cost: 0.02 } })],
  });

  const tasks = buildTasks([orchestrator]);

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.usage.input, 120);
  assert.equal(tasks[0]!.usage.output, 55);
  assert.ok(Math.abs(tasks[0]!.usage.cost - 0.12) < 1e-9);
});

test("C1: a configured-profile span's forwardedUsage is EXCLUDED from the task total when a same-profile child was joined (the child's own usage already carries it — counted once)", () => {
  const orchestrator = makeRecord({
    id: "o2",
    pid: 20,
    parentPid: 1,
    startedAt: iso(0),
    settledAt: iso(10),
    usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
    subagents: [span({ profile: "configured", forwardedUsage: { input: 500, output: 200, cost: 1.5 } })],
  });
  const child = makeRecord({
    id: "o2-child",
    role: "subagent",
    pid: 21,
    parentPid: 20,
    startedAt: iso(1),
    settledAt: iso(9),
    usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 1.5 },
    profile: "configured",
  });

  const tasks = buildTasks([orchestrator, child]);

  assert.equal(tasks.length, 1);
  // Child usage counted once via the ordinary join; forwardedUsage is not
  // added on top of it.
  assert.deepEqual(tasks[0]!.usage, { input: 600, output: 200, cacheRead: 0, cacheWrite: 0, cost: 1.6 });
});

test("C1: a configured-profile span's forwardedUsage IS included when no same-profile child was joined in this task (undercount avoided)", () => {
  const orchestrator = makeRecord({
    id: "o3",
    pid: 30,
    parentPid: 1,
    startedAt: iso(0),
    settledAt: iso(10),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    subagents: [span({ profile: "configured", forwardedUsage: { input: 500, output: 200, cost: 1.5 } })],
  });

  const tasks = buildTasks([orchestrator]);

  assert.deepEqual(tasks[0]!.usage, { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 1.5 });
});

test("C1: an ambiguous span (profile undefined) never carries forwardedUsage in the first place, so buildTasks has nothing to add for it", () => {
  const orchestrator = makeRecord({
    id: "o4",
    pid: 40,
    parentPid: 1,
    startedAt: iso(0),
    settledAt: iso(10),
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    subagents: [span({ profile: undefined, forwardedUsage: undefined })],
  });

  const tasks = buildTasks([orchestrator]);

  assert.deepEqual(tasks[0]!.usage, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
});

test("C1: a joined child of a DIFFERENT profile does not suppress an unrelated span's forwardedUsage", () => {
  const orchestrator = makeRecord({
    id: "o5",
    pid: 50,
    parentPid: 1,
    startedAt: iso(0),
    settledAt: iso(10),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    subagents: [span({ profile: "pi-reference", forwardedUsage: { input: 10, cost: 0.01 } })],
  });
  const child = makeRecord({
    id: "o5-child",
    role: "subagent",
    pid: 51,
    parentPid: 50,
    startedAt: iso(1),
    settledAt: iso(9),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    profile: "gentle-pi",
  });

  const tasks = buildTasks([orchestrator, child]);

  assert.deepEqual(tasks[0]!.usage, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
});

// --- Rescue by confirmed parent process identity -----------------------------
// A child that started AFTER every record of its parent settled (its parent's
// run was never recorded, or the parent crashed) used to be an orphan: never
// a task, never synced. Its `orchestratorRef` proves WHICH live process
// launched it, so it can still join that process's most recent earlier
// record. This is identity, never time containment alone (SUBAGENT-REQ-007).

const PROC_START = iso(0);
function parentRef(overrides: Partial<{ pid: number; project: string; startedAt: string }> = {}) {
  return { pid: 100, project: "/proj", startedAt: PROC_START, ...overrides };
}

test("rescue: a child that started after its parent's last record settled joins that record through orchestratorRef", () => {
  const first = makeRecord({ id: "p1", pid: 100, startedAt: iso(10), settledAt: iso(20) });
  const last = makeRecord({ id: "p2", pid: 100, startedAt: iso(100), settledAt: iso(130) });
  const late = makeRecord({ id: "c1", role: "subagent", pid: 300, parentPid: 100, startedAt: iso(500), settledAt: iso(900), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 4 }, orchestratorRef: parentRef() });

  const tasks = buildTasks([first, last, late]);

  assert.deepEqual(tasks.map((task) => task.subagents.length), [0, 1]);
  assert.equal(tasks[1]!.usage.cost, 4);
  assert.equal(tasks[1]!.wallMs, 30000 + 400000); // union of two disjoint intervals, never the gap between them
  assert.equal(tasks[1]!.endedAt, iso(900));
  assert.equal(orphanSubagents([first, last, late]).length, 0);
});

test("rescue: a nested grandchild joins the ROOT process named by orchestratorRef, not its immediate parent pid", () => {
  const root = makeRecord({ id: "p1", pid: 100, startedAt: iso(10), settledAt: iso(20) });
  const grandchild = makeRecord({ id: "g1", role: "subagent", pid: 400, parentPid: 300, startedAt: iso(50), settledAt: iso(60), orchestratorRef: parentRef() });
  assert.equal(buildTasks([root, grandchild])[0]!.subagents.length, 1);
});

test("rescue never joins a record of a DIFFERENT process that merely reused the pid (record older than the referenced process)", () => {
  const stale = makeRecord({ id: "old", pid: 100, startedAt: iso(10), settledAt: iso(20) });
  const child = makeRecord({ id: "c1", role: "subagent", pid: 300, parentPid: 100, startedAt: iso(500), settledAt: iso(600), orchestratorRef: parentRef({ startedAt: iso(200) }) });
  assert.equal(buildTasks([stale, child])[0]!.subagents.length, 0);
  assert.equal(orphanSubagents([stale, child]).length, 1);
});

test("rescue never joins a record that started AFTER the child did", () => {
  const later = makeRecord({ id: "p9", pid: 100, startedAt: iso(700), settledAt: iso(800) });
  const child = makeRecord({ id: "c1", role: "subagent", pid: 300, parentPid: 100, startedAt: iso(500), settledAt: iso(600), orchestratorRef: parentRef() });
  assert.equal(buildTasks([later, child])[0]!.subagents.length, 0);
});

test("rescue needs an orchestratorRef: pid and ordering alone never join (no time-only join)", () => {
  const parent = makeRecord({ id: "p1", pid: 100, startedAt: iso(10), settledAt: iso(20) });
  const child = makeRecord({ id: "c1", role: "subagent", pid: 300, parentPid: 100, startedAt: iso(500), settledAt: iso(600) });
  assert.equal(buildTasks([parent, child])[0]!.subagents.length, 0);
  assert.equal(orphanSubagents([parent, child]).length, 1);
});

test("rescue never anchors on an uncertain record, and never overrides a normal in-window match", () => {
  const uncertain = makeRecord({ id: "u1", pid: 100, startedAt: iso(300), settledAt: iso(310), roleConfidence: "uncertain" });
  const confirmed = makeRecord({ id: "p1", pid: 100, startedAt: iso(10), settledAt: iso(20) });
  const late = makeRecord({ id: "c1", role: "subagent", pid: 300, parentPid: 100, startedAt: iso(500), settledAt: iso(600), orchestratorRef: parentRef() });
  const tasks = buildTasks([uncertain, confirmed, late]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.id, "p1");
  assert.equal(tasks[0]!.subagents.length, 1);

  const windowed = makeRecord({ id: "p2", pid: 100, startedAt: iso(40), settledAt: iso(90) });
  const newest = makeRecord({ id: "p3", pid: 100, startedAt: iso(45), settledAt: iso(46) });
  const inWindow = makeRecord({ id: "c2", role: "subagent", pid: 301, parentPid: 100, startedAt: iso(50), settledAt: iso(60), orchestratorRef: parentRef() });
  const byId = new Map(buildTasks([windowed, newest, inWindow]).map((task) => [task.id, task.subagents.length]));
  assert.equal(byId.get("p2"), 1);
  assert.equal(byId.get("p3"), 0);
});

test("rescue: a GRANDCHILD rescued onto the root never cancels the root's own forwardedUsage — it is not the process behind any of its spans", () => {
  const anchor = makeRecord({ id: "p1", pid: 100, startedAt: iso(10), settledAt: iso(20), subagents: [span({ profile: "x", forwardedUsage: { cost: 5 } })] });
  const grandchild = makeRecord({ id: "g1", role: "subagent", pid: 400, parentPid: 300, profile: "x", startedAt: iso(500), settledAt: iso(600), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 2 }, orchestratorRef: parentRef() });
  assert.equal(buildTasks([anchor, grandchild])[0]!.usage.cost, 7);
});

test("rescue: a record written on another machine is never an anchor, even with the same pid", () => {
  const other = makeRecord({ id: "p1", pid: 100, machine: "laptop-b", startedAt: iso(10), settledAt: iso(20) });
  const child = makeRecord({ id: "c1", role: "subagent", pid: 300, parentPid: 100, machine: "laptop-a", startedAt: iso(500), settledAt: iso(600), orchestratorRef: parentRef() });
  assert.equal(buildTasks([other, child])[0]!.subagents.length, 0);
});

test("a record recovered from a crash checkpoint under the SAME id as an already-written one counts once: the most complete copy wins", () => {
  const settled = makeRecord({ id: "same", startedAt: iso(0), settledAt: iso(10), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 5 } });
  const recoveredEarlier = makeRecord({ id: "same", status: "interrupted", startedAt: iso(0), settledAt: iso(8), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 4 } });
  const tasks = buildTasks([settled, recoveredEarlier]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.usage.cost, 5);
  assert.equal(tasks[0]!.status, "completed");

  const recoveredLater = makeRecord({ id: "same", status: "interrupted", startedAt: iso(0), settledAt: iso(30), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 9 } });
  assert.equal(buildTasks([settled, recoveredLater])[0]!.usage.cost, 9);
});

test("forwarded usage is cancelled by the span's own child even when that child started just AFTER the parent settled (gentle-pi timing) — never billed twice", () => {
  const parent = makeRecord({ id: "p1", pid: 100, startedAt: iso(0), settledAt: iso(10), subagents: [span({ profile: "configured", forwardedUsage: { cost: 7 } })] });
  const child = makeRecord({ id: "c1", role: "subagent", pid: 200, parentPid: 100, profile: "configured", startedAt: iso(11), settledAt: iso(60), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 7 }, orchestratorRef: parentRef() });
  assert.equal(buildTasks([parent, child])[0]!.usage.cost, 7);
});

test("the primary parentPid+window join never crosses machines either", () => {
  const parent = makeRecord({ id: "p1", pid: 100, machine: "mac-a", startedAt: iso(0), settledAt: iso(100) });
  const child = makeRecord({ id: "c1", role: "subagent", pid: 200, parentPid: 100, machine: "mac-b", startedAt: iso(10), settledAt: iso(20) });
  assert.equal(buildTasks([parent, child])[0]!.subagents.length, 0);
});
