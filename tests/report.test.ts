import assert from "node:assert/strict";
import { test } from "node:test";
import { formatClients, formatReport, formatSessions, formatTasks, localDay, summarize, summarizeByClient } from "../src/adapters/report.ts";
import { buildSessions, buildTasks } from "../src/domain/task-view.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/tmp/project",
    prompt: "hello",
    startedAt: "2026-09-10T16:00:00.000Z",
    settledAt: "2026-09-10T16:10:00.000Z",
    wallMs: 600000,
    waitingMs: 100000,
    workMs: 500000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    status: "completed",
    ...overrides,
  };
}

test("summarize groups totals by role for a given local day", () => {
  const sameInstant = "2026-09-10T12:00:00.000Z";
  const day = localDay(sameInstant);
  const records: WorkRecord[] = [
    makeRecord({ id: "r1", role: "orchestrator", startedAt: sameInstant, workMs: 100, waitingMs: 10, wallMs: 110 }),
    makeRecord({ id: "r2", role: "orchestrator", startedAt: sameInstant, workMs: 200, waitingMs: 20, wallMs: 220 }),
    makeRecord({ id: "r3", role: "subagent", startedAt: sameInstant, workMs: 50, waitingMs: 5, wallMs: 55, pid: 2, parentPid: 1 }),
  ];

  const summary = summarize(records, { day });

  assert.deepEqual(summary.orchestrator, { workMs: 300, waitingMs: 30, wallMs: 330, count: 2, cost: 0, segments: {} });
  assert.deepEqual(summary.subagent, { workMs: 50, waitingMs: 5, wallMs: 55, count: 1, cost: 0, segments: {} });
});

test("summarize excludes records outside the requested local day", () => {
  const records: WorkRecord[] = [
    makeRecord({ id: "r1", startedAt: "2026-09-10T12:00:00.000Z", workMs: 100 }),
    makeRecord({ id: "r2", startedAt: "2026-01-15T12:00:00.000Z", workMs: 999 }),
  ];

  const summary = summarize(records, { day: localDay("2026-09-10T12:00:00.000Z") });

  assert.equal(summary.orchestrator.count, 1);
  assert.equal(summary.orchestrator.workMs, 100);
});

test("summarize with all:true includes every record regardless of day", () => {
  const records: WorkRecord[] = [
    makeRecord({ id: "r1", startedAt: "2026-01-01T00:00:00.000Z", workMs: 10 }),
    makeRecord({ id: "r2", startedAt: "2026-09-10T00:00:00.000Z", workMs: 20 }),
  ];

  const summary = summarize(records, { all: true });

  assert.equal(summary.orchestrator.count, 2);
  assert.equal(summary.orchestrator.workMs, 30);
});

test("summarize defaults to today when neither day nor all is given", () => {
  const now = new Date();
  const todayIso = now.toISOString();
  const records: WorkRecord[] = [makeRecord({ id: "r1", startedAt: todayIso, workMs: 42 })];

  const summary = summarize(records, {});

  assert.equal(summary.orchestrator.count, 1);
  assert.equal(summary.orchestrator.workMs, 42);
});

test("summarize returns zeroed totals for roles with no records", () => {
  const summary = summarize([], { all: true });

  assert.deepEqual(summary.orchestrator, { workMs: 0, waitingMs: 0, wallMs: 0, count: 0, cost: 0, segments: {} });
  assert.deepEqual(summary.subagent, { workMs: 0, waitingMs: 0, wallMs: 0, count: 0, cost: 0, segments: {} });
  assert.deepEqual(summary.tasks, { count: 0, wallMs: 0, workMs: 0, cost: 0, segments: {} });
});

test("summarize computes a tasks segment as the union of parent and child spans for the given day", () => {
  const sameInstant = "2026-09-10T12:00:00.000Z";
  const day = localDay(sameInstant);
  const parent = makeRecord({
    id: "p1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    startedAt: sameInstant,
    settledAt: new Date(Date.parse(sameInstant) + 33_000).toISOString(),
    wallMs: 33000,
    waitingMs: 0,
    workMs: 33000,
  });
  const child = makeRecord({
    id: "c1",
    role: "subagent",
    pid: 200,
    parentPid: 100,
    startedAt: new Date(Date.parse(sameInstant) + 20_000).toISOString(),
    settledAt: new Date(Date.parse(sameInstant) + 60_000).toISOString(),
    wallMs: 40000,
    waitingMs: 0,
    workMs: 40000,
  });

  const summary = summarize([parent, child], { day });

  assert.equal(summary.tasks.count, 1);
  assert.equal(summary.tasks.wallMs, 60000); // union [0,33] u [20,60] = [0,60]
  assert.equal(summary.tasks.workMs, 60000);
});

test("summarize treats a missing or non-finite usage.cost as zero", () => {
  const sameInstant = "2026-09-10T10:00:00.000Z";
  const day = localDay(sameInstant);
  const record = makeRecord({
    id: "r1",
    startedAt: sameInstant,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } as unknown as WorkRecord["usage"],
  });

  const summary = summarize([record], { day });

  assert.equal(summary.orchestrator.cost, 0);
  assert.equal(summary.tasks.cost, 0);
});

test("formatReport renders a short human-readable summary including the tasks segment", () => {
  const sameInstant = "2026-09-10T10:00:00.000Z";
  const day = localDay(sameInstant);
  const summary = summarize(
    [
      makeRecord({ id: "r1", role: "orchestrator", workMs: 300000, waitingMs: 30000, wallMs: 330000, startedAt: sameInstant }),
      makeRecord({ id: "r2", role: "subagent", workMs: 90000, waitingMs: 0, wallMs: 90000, startedAt: sameInstant, pid: 2, parentPid: 1 }),
    ],
    { day },
  );

  const text = formatReport(summary);

  assert.match(text, /orchestrator/i);
  assert.match(text, /subagent/i);
  assert.match(text, /5m/);
  assert.match(text, /tasks: \d+, wall \d+m\d\ds, work \d+m\d\ds/);
});

test("formatTasks renders one line per task with time, wall/work, subagent count, and truncated prompt", () => {
  const longPrompt = "x".repeat(100);
  const parent = makeRecord({
    id: "p1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    prompt: longPrompt,
    startedAt: "2026-09-10T12:00:00.000Z",
    settledAt: "2026-09-10T12:00:30.000Z",
    wallMs: 30000,
    waitingMs: 0,
    workMs: 30000,
  });
  const child = makeRecord({
    id: "c1",
    role: "subagent",
    pid: 200,
    parentPid: 100,
    startedAt: "2026-09-10T12:00:10.000Z",
    settledAt: "2026-09-10T12:00:40.000Z",
  });

  const tasks = buildTasks([parent, child]);
  const text = formatTasks(tasks);

  assert.match(text, /wall/);
  assert.match(text, /work/);
  assert.match(text, /subagents 1/);
  assert.equal(text.includes(longPrompt), false);
  assert.ok(text.split("\n")[0]!.length < longPrompt.length + 40);
});

test("formatTasks reports 'no tasks' for an empty list", () => {
  assert.equal(formatTasks([]), "no tasks");
});

test("formatSessions renders one line per session with truncated id, time range, wall/work, and task count", () => {
  const parent = makeRecord({
    id: "p1",
    sessionId: "0123456789abcdef",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    startedAt: "2026-09-10T12:00:00.000Z",
    settledAt: "2026-09-10T12:00:30.000Z",
  });

  const sessions = buildSessions(buildTasks([parent]));
  const text = formatSessions(sessions);

  assert.match(text, /^01234567/);
  assert.match(text, /wall/);
  assert.match(text, /work/);
  assert.match(text, /tasks 1/);
});

test("formatSessions reports 'no sessions' for an empty list", () => {
  assert.equal(formatSessions([]), "no sessions");
});

test("summarize accumulates cost per role and per task, including subagent cost", () => {
  const sameInstant = "2026-09-10T10:00:00.000Z";
  const day = localDay(sameInstant);
  const parent = makeRecord({
    id: "p1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    startedAt: sameInstant,
    settledAt: new Date(Date.parse(sameInstant) + 30_000).toISOString(),
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
  });
  const child = makeRecord({
    id: "c1",
    role: "subagent",
    pid: 200,
    parentPid: 100,
    startedAt: new Date(Date.parse(sameInstant) + 5_000).toISOString(),
    settledAt: new Date(Date.parse(sameInstant) + 20_000).toISOString(),
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
  });

  const summary = summarize([parent, child], { day });

  assert.equal(summary.orchestrator.cost, 0.25);
  assert.equal(summary.subagent.cost, 0.5);
  assert.equal(summary.tasks.cost, 0.75);
});

test("formatReport, formatTasks and formatSessions show cost in dollars", () => {
  const sameInstant = "2026-09-10T10:00:00.000Z";
  const day = localDay(sameInstant);
  const parent = makeRecord({
    id: "p1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    sessionId: "session-1",
    startedAt: sameInstant,
    settledAt: new Date(Date.parse(sameInstant) + 30_000).toISOString(),
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 1.2345 },
  });

  const summary = summarize([parent], { day });
  assert.match(formatReport(summary), /orchestrator:.*\$1\.23/);
  assert.match(formatReport(summary), /tasks:.*\$1\.23/);

  const tasks = buildTasks([parent]);
  assert.match(formatTasks(tasks), /\$1\.23/);
  assert.match(formatSessions(buildSessions(tasks)), /\$1\.23/);
});

test("summarize accumulates segments per role and sums them into the tasks segment", () => {
  const sameInstant = "2026-09-10T10:00:00.000Z";
  const day = localDay(sameInstant);
  const parent = makeRecord({
    id: "p1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    startedAt: sameInstant,
    settledAt: new Date(Date.parse(sameInstant) + 30_000).toISOString(),
    segments: { review: 12000 },
  });
  const child = makeRecord({
    id: "c1",
    role: "subagent",
    pid: 200,
    parentPid: 100,
    startedAt: new Date(Date.parse(sameInstant) + 5_000).toISOString(),
    settledAt: new Date(Date.parse(sameInstant) + 20_000).toISOString(),
    segments: { review: 3000, commit: 1000 },
  });

  const summary = summarize([parent, child], { day });

  assert.deepEqual(summary.orchestrator.segments, { review: 12000 });
  assert.deepEqual(summary.subagent.segments, { review: 3000, commit: 1000 });
  assert.deepEqual(summary.tasks.segments, { review: 15000, commit: 1000 });
});

test("summarize treats records without segments (older log lines) as {}", () => {
  const sameInstant = "2026-09-10T10:00:00.000Z";
  const day = localDay(sameInstant);
  const record = makeRecord({ id: "r1", startedAt: sameInstant, segments: undefined });

  const summary = summarize([record], { day });

  assert.deepEqual(summary.orchestrator.segments, {});
});

test("formatReport appends a segments line only when a tag is non-zero, sorted alphabetically", () => {
  const sameInstant = "2026-09-10T10:00:00.000Z";
  const day = localDay(sameInstant);
  const parent = makeRecord({
    id: "p1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    startedAt: sameInstant,
    settledAt: new Date(Date.parse(sameInstant) + 62_000).toISOString(),
    segments: { review: 62000, commit: 10000 },
  });

  const summary = summarize([parent], { day });
  const text = formatReport(summary);

  assert.match(text, /segments: commit 0m10s, review 1m02s/);
});

test("formatReport omits the segments line when no tag is non-zero", () => {
  const sameInstant = "2026-09-10T10:00:00.000Z";
  const day = localDay(sameInstant);
  const parent = makeRecord({ id: "p1", startedAt: sameInstant });

  const summary = summarize([parent], { day });
  const text = formatReport(summary);

  assert.equal(text.includes("segments:"), false);
});

test("formatTasks appends segment pairs after the cost, only for non-zero tags", () => {
  const parent = makeRecord({
    id: "p1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    startedAt: "2026-09-10T12:00:00.000Z",
    settledAt: "2026-09-10T12:00:30.000Z",
    segments: { review: 12000 },
  });

  const tasks = buildTasks([parent]);
  const text = formatTasks(tasks);

  assert.match(text, /review 0m12s/);
});

test("formatTasks shows no segment text when the task has no segments", () => {
  const parent = makeRecord({ id: "p1", pid: 100, parentPid: 1 });

  const tasks = buildTasks([parent]);
  const text = formatTasks(tasks);

  assert.equal(text.includes("review"), false);
});

test("formatTasks shows client:<name> after the time when the task has a client", () => {
  const parent = makeRecord({
    id: "p1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    client: "acme",
    startedAt: "2026-09-10T12:00:00.000Z",
    settledAt: "2026-09-10T12:00:30.000Z",
  });

  const tasks = buildTasks([parent]);
  const text = formatTasks(tasks);

  assert.match(text, /^\d\d:\d\d {2}client:acme {2}wall/);
});

test("formatTasks shows no client text when the task has no client", () => {
  const parent = makeRecord({ id: "p1", pid: 100, parentPid: 1 });

  const tasks = buildTasks([parent]);
  const text = formatTasks(tasks);

  assert.equal(text.includes("client:"), false);
});

test("summarizeByClient totals work, waiting, wall, cost and task count per client, grouping clientless tasks under (none)", () => {
  const parentA = makeRecord({
    id: "a1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    client: "acme",
    startedAt: "2026-09-10T12:00:00.000Z",
    settledAt: "2026-09-10T12:01:00.000Z",
    wallMs: 60000,
    waitingMs: 10000,
    workMs: 50000,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 },
  });
  const parentB = makeRecord({
    id: "a2",
    role: "orchestrator",
    pid: 101,
    parentPid: 1,
    client: "acme",
    startedAt: "2026-09-10T13:00:00.000Z",
    settledAt: "2026-09-10T13:00:30.000Z",
    wallMs: 30000,
    waitingMs: 0,
    workMs: 30000,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
  });
  const parentC = makeRecord({
    id: "b1",
    role: "orchestrator",
    pid: 102,
    parentPid: 1,
    startedAt: "2026-09-10T14:00:00.000Z",
    settledAt: "2026-09-10T14:00:10.000Z",
    wallMs: 10000,
    waitingMs: 0,
    workMs: 10000,
  });

  const tasks = buildTasks([parentA, parentB, parentC]);
  const totals = summarizeByClient(tasks);

  assert.deepEqual(totals.get("acme"), { wallMs: 90000, waitingMs: 10000, workMs: 80000, cost: 1.5, count: 2 });
  assert.deepEqual(totals.get("(none)"), { wallMs: 10000, waitingMs: 0, workMs: 10000, cost: 0, count: 1 });
});

test("formatClients renders one line per client sorted alphabetically, with (none) as a normal entry", () => {
  const parentA = makeRecord({ id: "a1", pid: 100, parentPid: 1, client: "zeta", wallMs: 60000, waitingMs: 0, workMs: 60000 });
  const parentB = makeRecord({ id: "b1", pid: 101, parentPid: 1, wallMs: 10000, waitingMs: 0, workMs: 10000 });
  const parentC = makeRecord({ id: "c1", pid: 102, parentPid: 1, client: "acme", wallMs: 20000, waitingMs: 0, workMs: 20000 });

  const tasks = buildTasks([parentA, parentB, parentC]);
  const text = formatClients(summarizeByClient(tasks));
  const lines = text.split("\n");

  assert.match(lines[0]!, /^\(none\)/);
  assert.match(lines[1]!, /^acme/);
  assert.match(lines[2]!, /^zeta/);
  assert.match(text, /tasks 1/);
});

test("formatClients reports 'no clients' for an empty list", () => {
  assert.equal(formatClients(summarizeByClient([])), "no clients");
});

test("formatSessions appends segment pairs after the cost, only for non-zero tags", () => {
  const parent = makeRecord({
    id: "p1",
    sessionId: "session-1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    startedAt: "2026-09-10T12:00:00.000Z",
    settledAt: "2026-09-10T12:00:30.000Z",
    segments: { review: 12000, commit: 5000 },
  });

  const sessions = buildSessions(buildTasks([parent]));
  const text = formatSessions(sessions);

  assert.match(text, /commit 0m05s, review 0m12s/);
});
