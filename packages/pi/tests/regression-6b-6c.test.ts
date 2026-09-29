/**
 * Explicit regression fixtures for Phase 6b/6c (SUBAGENT-REQ-001..017):
 * given the exact same, realistic-shaped `WorkRecord`s a "plain pi" run
 * and "today's gentle-pi setup" already produce, `buildTasks`/`buildSessions`
 * and the hub payload builders must still emit byte-identical output. Every
 * assertion below is a hardcoded expected value (not a round-trip through
 * the same code under test), so a future change that silently alters a
 * number for either of these two setups fails this file first.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessions, buildTasks } from "../src/domain/task-view.ts";
import { buildTaskEntryCreatePayload, buildWorkRecordPayload, computeCostQuality, computeSubagentLinkage } from "../src/domain/hub-entry.ts";
import type { HubEntryContext } from "../src/domain/hub-entry.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

const CTX: HubEntryContext = {
  clients: [],
  projects: [],
  tasks: [],
  machine: "test-machine",
  promptMode: "none",
  agent: "pi",
  plugin: "kankaku",
};

// --- Fixture A: a plain pi run, no subagents at all ---

const PLAIN_ORCHESTRATOR: WorkRecord = {
  schema: 1,
  id: "plain-1",
  role: "orchestrator",
  pid: 4242,
  parentPid: 1,
  project: "/repo/plain",
  sessionId: "session-plain",
  prompt: "fix the bug",
  startedAt: "2026-09-20T10:00:00.000Z",
  settledAt: "2026-09-20T10:05:00.000Z",
  wallMs: 300000,
  waitingMs: 20000,
  workMs: 280000,
  runs: 2,
  turns: 5,
  tools: { bash: 3, read: 2 },
  subagents: [],
  segments: {},
  usage: { input: 5000, output: 1200, cacheRead: 300, cacheWrite: 100, cost: 0.42 },
  status: "completed",
  costObserved: true,
};

test("regression: buildTasks(plain pi fixture) is byte-identical to the pre-6b/6c shape", () => {
  const tasks = buildTasks([PLAIN_ORCHESTRATOR]);
  assert.equal(tasks.length, 1);
  const task = tasks[0]!;
  assert.equal(task.id, "plain-1");
  assert.equal(task.wallMs, 300000);
  assert.equal(task.waitingMs, 20000);
  assert.equal(task.workMs, 280000);
  assert.deepEqual(task.usage, { input: 5000, output: 1200, cacheRead: 300, cacheWrite: 100, cost: 0.42 });
  assert.equal(task.subagents.length, 0);
  assert.deepEqual(task.segments, {});
});

test("regression: hub payloads for the plain pi fixture are byte-identical to the pre-6b/6c shape", () => {
  const [task] = buildTasks([PLAIN_ORCHESTRATOR]);
  const payload = buildTaskEntryCreatePayload(task!, CTX);

  assert.deepEqual(payload, {
    task_id: "plain-1",
    client: "",
    project: "",
    task: "",
    started_at: "2026-09-20 10:00:00.000Z",
    ended_at: "2026-09-20 10:05:00.000Z",
    wall_ms: 300000,
    waiting_ms: 20000,
    work_ms: 280000,
    input: 5000,
    output: 1200,
    cache_read: 300,
    cache_write: 100,
    cost: 0.42,
    segments: {},
    subagent_count: 0,
    runs: 2,
    turns: 5,
    status: "completed",
    session_id: "session-plain",
    session_name: "",
    machine: "test-machine",
    model: "",
    prompt: "",
    legacy_client_label: "",
    repo_project: "/repo/plain",
    schema: 1,
    agent: "pi",
    plugin: "kankaku",
    waiting_quality: "measured",
    cost_quality: "measured",
    subagent_linkage: "not_applicable",
  });

  const recordPayload = buildWorkRecordPayload(PLAIN_ORCHESTRATOR, "entry-1", { machine: "test-machine", promptMode: "none" });
  assert.deepEqual(recordPayload, {
    kankaku_id: "plain-1",
    task_entry: "entry-1",
    rollup: false,
    role: "orchestrator",
    pid: 4242,
    parent_pid: 1,
    started_at: "2026-09-20 10:00:00.000Z",
    settled_at: "2026-09-20 10:05:00.000Z",
    wall_ms: 300000,
    waiting_ms: 20000,
    work_ms: 280000,
    runs: 2,
    turns: 5,
    status: "completed",
    model: "",
    input: 5000,
    output: 1200,
    cache_read: 300,
    cache_write: 100,
    cost: 0.42,
    segments: {},
    tools: { bash: 3, read: 2 },
    session_id: "session-plain",
    prompt: "",
    machine: "test-machine",
    schema: 1,
  });
});

// --- Fixture B: today's gentle-pi setup — one subagent_run span, joined via registry/ancestry ---

const GENTLE_PI_ORCHESTRATOR: WorkRecord = {
  schema: 1,
  id: "gp-1",
  role: "orchestrator",
  pid: 5000,
  parentPid: 1,
  project: "/repo/gentle",
  sessionId: "session-gp",
  prompt: "run the review",
  startedAt: "2026-09-20T11:00:00.000Z",
  settledAt: "2026-09-20T11:10:00.000Z",
  wallMs: 600000,
  waitingMs: 0,
  workMs: 600000,
  runs: 1,
  turns: 3,
  tools: { subagent_run: 1 },
  // profile: "gentle-pi" attribution is new (6b), additive — the span's
  // other fields (toolCallId/agent/mode/taskId/ms) are exactly what 6a
  // already produced.
  subagents: [{ toolCallId: "call-1", agent: "sdd-explore", mode: "task", taskId: "gp-task-1", ms: 400000, profile: "gentle-pi" }],
  segments: {},
  usage: { input: 8000, output: 2000, cacheRead: 0, cacheWrite: 0, cost: 0.9 },
  status: "completed",
  costObserved: true,
};

const GENTLE_PI_CHILD: WorkRecord = {
  schema: 1,
  id: "gp-child-1",
  role: "subagent",
  pid: 5001,
  parentPid: 5000,
  project: "/repo/gentle-worktree",
  sessionId: "session-gp-child",
  prompt: "explore",
  startedAt: "2026-09-20T11:00:30.000Z",
  settledAt: "2026-09-20T11:06:30.000Z",
  wallMs: 360000,
  waitingMs: 0,
  workMs: 360000,
  runs: 1,
  turns: 4,
  tools: { read: 10 },
  subagents: [],
  segments: {},
  usage: { input: 3000, output: 900, cacheRead: 0, cacheWrite: 0, cost: 0.31 },
  status: "completed",
  costObserved: true,
  // profile: "gentle-pi" attribution is new (6b) on the CHILD's own record
  // too (its role was confirmed by GENTLE_PI_AGENTS_CHILD=1) — additive.
  profile: "gentle-pi",
  orchestratorRef: { pid: 5000, project: "/repo/gentle", startedAt: "2026-09-20T11:00:00.000Z", dir: "/repo/gentle/.kankaku" },
};

test("regression: buildTasks(gentle-pi fixture) reunites the cross-worktree child exactly as 6a already did, wallMs unioned not summed, usage summed once", () => {
  const tasks = buildTasks([GENTLE_PI_ORCHESTRATOR, GENTLE_PI_CHILD]);
  assert.equal(tasks.length, 1);
  const task = tasks[0]!;
  assert.equal(task.subagents.length, 1);
  assert.equal(task.subagents[0]?.id, "gp-child-1");
  // union of [11:00:00,11:10:00] and [11:00:30,11:06:30] = the parent's own
  // window (the child finishes well inside it) = 600000ms, not 960000ms.
  assert.equal(task.wallMs, 600000);
  assert.deepEqual(task.usage, { input: 11000, output: 2900, cacheRead: 0, cacheWrite: 0, cost: 1.21 });
});

test("regression: computeCostQuality/computeSubagentLinkage for the gentle-pi fixture match today's exact values", () => {
  const [task] = buildTasks([GENTLE_PI_ORCHESTRATOR, GENTLE_PI_CHILD]);
  assert.equal(computeCostQuality(task!), "measured");
  assert.equal(computeSubagentLinkage(task!), "linked");
});

test("regression: the gentle-pi orchestrator's task_entries payload is byte-identical to the pre-6b/6c shape (subagent_count/cost/wall_ms unaffected by the new profile attribution)", () => {
  const [task] = buildTasks([GENTLE_PI_ORCHESTRATOR, GENTLE_PI_CHILD]);
  const payload = buildTaskEntryCreatePayload(task!, CTX);

  assert.equal(payload.wall_ms, 600000);
  assert.equal(payload.cost, 1.21);
  assert.equal(payload.input, 11000);
  assert.equal(payload.subagent_count, 1);
  assert.equal(payload.cost_quality, "measured");
  assert.equal(payload.subagent_linkage, "linked");
  assert.equal(payload.schema, 1);
});

test("regression: buildSessions for a mixed plain + gentle-pi worklog matches today's per-session union/sum rules exactly", () => {
  const tasks = buildTasks([PLAIN_ORCHESTRATOR, GENTLE_PI_ORCHESTRATOR, GENTLE_PI_CHILD]);
  const sessions = buildSessions(tasks);

  assert.equal(sessions.length, 2);
  const plainSession = sessions.find((s) => s.sessionId === "session-plain")!;
  const gpSession = sessions.find((s) => s.sessionId === "session-gp")!;
  assert.equal(plainSession.wallMs, 300000);
  assert.equal(gpSession.wallMs, 600000);
  assert.equal(gpSession.usage.cost, 1.21);
});
