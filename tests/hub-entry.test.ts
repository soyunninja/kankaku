import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPromptPrivacy,
  buildTaskEntryCreatePayload,
  buildTaskEntryUpdatePayload,
  buildWorkRecordPayload,
  resolveTaskAssignment,
  taskWorkRecords,
} from "../src/domain/hub-entry.ts";
import type { HubEntryContext } from "../src/domain/hub-entry.ts";
import type { TaskView } from "../src/domain/task-view.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";
import type { Client, Project } from "../src/domain/work-target.ts";

function iso(secondsFromEpoch: number): string {
  return new Date(secondsFromEpoch * 1000).toISOString();
}

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec-1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    project: "/repo/proj",
    sessionId: "session-a",
    prompt: "do the thing",
    startedAt: iso(0),
    settledAt: iso(10),
    wallMs: 10000,
    waitingMs: 1000,
    workMs: 9000,
    runs: 1,
    turns: 3,
    tools: { bash: 2 },
    subagents: [],
    usage: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, cost: 0.12 },
    status: "completed",
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskView> = {}, orchestratorOverrides: Partial<WorkRecord> = {}): TaskView {
  const orchestrator = makeRecord(orchestratorOverrides);
  return {
    id: orchestrator.id,
    sessionId: orchestrator.sessionId,
    project: orchestrator.project,
    prompt: orchestrator.prompt,
    startedAt: orchestrator.startedAt,
    endedAt: orchestrator.settledAt,
    wallMs: orchestrator.wallMs,
    waitingMs: orchestrator.waitingMs,
    workMs: orchestrator.workMs,
    status: orchestrator.status,
    orchestrator,
    subagents: [],
    usage: orchestrator.usage,
    segments: {},
    ...overrides,
  };
}

const client: Client = { id: "client-1", name: "Acme", code: "acme", active: true };
const unassigned: Client = { id: "client-unassigned", name: "Sin determinar", code: "sin-determinar", active: true, unassigned: true };
const project: Project = { id: "project-1", name: "Portal", clientId: "client-1", repoPaths: [], active: true };
const otherClientProject: Project = { id: "project-2", name: "Other", clientId: "client-other", repoPaths: [], active: true };

const ctx: HubEntryContext = {
  clients: [client, unassigned],
  projects: [project, otherClientProject],
  machine: "laptop",
  promptMode: "none",
  agent: "pi",
  agentVersion: "0.85.1",
  plugin: "kankaku",
  pluginVersion: "0.4.6",
};

test("resolveTaskAssignment links a task whose clientId still exists in the catalog", () => {
  const task = makeTask({ clientId: "client-1", clientName: "Acme", projectId: "project-1", projectName: "Portal" });
  const assignment = resolveTaskAssignment(task, ctx.clients, ctx.projects);
  assert.deepEqual(assignment, { clientId: "client-1", projectId: "project-1", legacyClientLabel: "", routedToUnassigned: false });
});

test("resolveTaskAssignment drops the project relation when it belongs to a different client", () => {
  const task = makeTask({ clientId: "client-1", projectId: "project-2" });
  const assignment = resolveTaskAssignment(task, ctx.clients, ctx.projects);
  assert.equal(assignment.projectId, "");
  assert.equal(assignment.clientId, "client-1");
});

test("resolveTaskAssignment drops the project relation when the project no longer exists", () => {
  const task = makeTask({ clientId: "client-1", projectId: "does-not-exist" });
  const assignment = resolveTaskAssignment(task, ctx.clients, ctx.projects);
  assert.equal(assignment.projectId, "");
});

test("resolveTaskAssignment routes a task with no clientId to the unassigned client, using the free-text client label", () => {
  const task = makeTask({ client: "cajamar" });
  const assignment = resolveTaskAssignment(task, ctx.clients, ctx.projects);
  assert.deepEqual(assignment, { clientId: "client-unassigned", projectId: "", legacyClientLabel: "cajamar", routedToUnassigned: true });
});

test("resolveTaskAssignment routes a task whose clientId no longer resolves to the unassigned client", () => {
  const task = makeTask({ clientId: "deleted-client", clientName: "Old Name" });
  const assignment = resolveTaskAssignment(task, ctx.clients, ctx.projects);
  assert.deepEqual(assignment, { clientId: "client-unassigned", projectId: "", legacyClientLabel: "Old Name", routedToUnassigned: true });
});

test("resolveTaskAssignment prefers the free-text client label over clientName when both are present", () => {
  const task = makeTask({ client: "cjamar", clientName: "Old Name" });
  const assignment = resolveTaskAssignment(task, ctx.clients, ctx.projects);
  assert.equal(assignment.legacyClientLabel, "cjamar");
});

test("resolveTaskAssignment leaves legacyClientLabel empty when neither client nor clientName is present", () => {
  const task = makeTask({});
  const assignment = resolveTaskAssignment(task, ctx.clients, ctx.projects);
  assert.equal(assignment.legacyClientLabel, "");
});

test("applyPromptPrivacy: none omits the prompt entirely", () => {
  assert.equal(applyPromptPrivacy("secret client details", "none"), "");
});

test("applyPromptPrivacy: truncated keeps the first 120 chars plus an ellipsis when cut", () => {
  const long = "x".repeat(200);
  const result = applyPromptPrivacy(long, "truncated");
  assert.equal(result, `${"x".repeat(120)}…`);
});

test("applyPromptPrivacy: truncated leaves a short prompt untouched", () => {
  assert.equal(applyPromptPrivacy("short", "truncated"), "short");
});

test("applyPromptPrivacy: full sends the prompt verbatim", () => {
  const long = "x".repeat(200);
  assert.equal(applyPromptPrivacy(long, "full"), long);
});

test("buildTaskEntryCreatePayload maps every field, in the contract's date format", () => {
  const task = makeTask({ clientId: "client-1", clientName: "Acme", projectId: "project-1", projectName: "Portal" });
  const payload = buildTaskEntryCreatePayload(task, { ...ctx, promptMode: "full" });

  assert.equal(payload.task_id, task.id);
  assert.equal(payload.client, "client-1");
  assert.equal(payload.project, "project-1");
  assert.equal(payload.task, "");
  assert.equal(payload.started_at, task.startedAt.replace("T", " "));
  assert.equal(payload.ended_at, task.endedAt.replace("T", " "));
  assert.equal(payload.wall_ms, task.wallMs);
  assert.equal(payload.waiting_ms, task.waitingMs);
  assert.equal(payload.work_ms, task.workMs);
  assert.equal(payload.input, task.usage.input);
  assert.equal(payload.output, task.usage.output);
  assert.equal(payload.cache_read, task.usage.cacheRead);
  assert.equal(payload.cache_write, task.usage.cacheWrite);
  assert.equal(payload.cost, task.usage.cost);
  assert.deepEqual(payload.segments, task.segments);
  assert.equal(payload.subagent_count, 0);
  assert.equal(payload.runs, task.orchestrator.runs);
  assert.equal(payload.turns, task.orchestrator.turns);
  assert.equal(payload.status, task.status);
  assert.equal(payload.session_id, task.sessionId);
  assert.equal(payload.machine, "laptop");
  assert.equal(payload.prompt, task.prompt);
  assert.equal(payload.legacy_client_label, "");
  assert.equal(payload.repo_project, task.project);
  assert.equal(payload.schema, task.orchestrator.schema);
  assert.equal(payload.agent, "pi");
  assert.equal(payload.agent_version, "0.85.1");
  assert.equal(payload.plugin, "kankaku");
  assert.equal(payload.plugin_version, "0.4.6");
  assert.equal(payload.waiting_quality, "measured");
  assert.equal(payload.cost_quality, "unknown"); // makeRecord's default usage.cost is set but costObserved is never set by the helper
  assert.equal(payload.subagent_linkage, "not_applicable");
});

test("buildTaskEntryCreatePayload omits agent_version/plugin_version when not known, but always sends agent/plugin", () => {
  const task = makeTask({});
  const payload = buildTaskEntryCreatePayload(task, { clients: [], projects: [], machine: "laptop", promptMode: "none", agent: "pi", plugin: "kankaku" });
  assert.equal(payload.agent, "pi");
  assert.equal(payload.plugin, "kankaku");
  assert.equal("agent_version" in payload, false);
  assert.equal("plugin_version" in payload, false);
});

test("computeCostQuality: measured when the orchestrator record observed a real cost figure", () => {
  const task = makeTask({}, { costObserved: true });
  assert.equal(buildTaskEntryCreatePayload(task, ctx).cost_quality, "measured");
});

test("computeCostQuality: measured when a joined subagent record observed a real cost figure, even if the orchestrator did not", () => {
  const child = makeRecord({ id: "child-1", role: "subagent", pid: 200, parentPid: 100, costObserved: true });
  const task = makeTask({ subagents: [child] });
  assert.equal(buildTaskEntryCreatePayload(task, ctx).cost_quality, "measured");
});

test("computeCostQuality: unknown when neither the orchestrator nor any subagent observed a cost figure", () => {
  const task = makeTask({});
  assert.equal(buildTaskEntryCreatePayload(task, ctx).cost_quality, "unknown");
});

test("computeSubagentLinkage: not_applicable when the orchestrator opened no subagent spans", () => {
  const task = makeTask({});
  assert.equal(buildTaskEntryCreatePayload(task, ctx).subagent_linkage, "not_applicable");
});

test("computeSubagentLinkage: linked when every subagent span has a joined child record", () => {
  const child = makeRecord({ id: "child-1", role: "subagent", pid: 200, parentPid: 100 });
  const task = makeTask({ subagents: [child] }, { subagents: [{ toolCallId: "call-1", agent: "reviewer", mode: "task", ms: 1000 }] });
  assert.equal(buildTaskEntryCreatePayload(task, ctx).subagent_linkage, "linked");
});

test("computeSubagentLinkage: unlinked when there are fewer joined children than opened spans", () => {
  const task = makeTask(
    { subagents: [] },
    { subagents: [{ toolCallId: "call-1", agent: "reviewer", mode: "task", ms: 1000 }] },
  );
  assert.equal(buildTaskEntryCreatePayload(task, ctx).subagent_linkage, "unlinked");
});

test("buildTaskEntryCreatePayload sends empty relation strings, not omitted or null, when unresolved", () => {
  const task = makeTask({});
  const payload = buildTaskEntryCreatePayload(task, { clients: [], projects: [], machine: "laptop", promptMode: "none", agent: "pi", plugin: "kankaku" });
  assert.equal(payload.client, "");
  assert.equal(payload.project, "");
  assert.equal(payload.task, "");
});

test("buildTaskEntryCreatePayload sends session_id/session_name as empty strings, not undefined, when absent", () => {
  const task = makeTask({ sessionId: undefined, sessionName: undefined });
  const payload = buildTaskEntryCreatePayload(task, ctx);
  assert.equal(payload.session_id, "");
  assert.equal(payload.session_name, "");
});

test("buildTaskEntryUpdatePayload omits client, project, task and legacy_client_label", () => {
  const task = makeTask({ clientId: "client-1", projectId: "project-1" });
  const update = buildTaskEntryUpdatePayload(task, ctx);
  assert.equal("client" in update, false);
  assert.equal("project" in update, false);
  assert.equal("task" in update, false);
  assert.equal("legacy_client_label" in update, false);
});

test("buildTaskEntryUpdatePayload keeps every measurement field", () => {
  const task = makeTask({ clientId: "client-1" });
  const create = buildTaskEntryCreatePayload(task, ctx);
  const update = buildTaskEntryUpdatePayload(task, ctx);
  assert.equal(update.wall_ms, create.wall_ms);
  assert.equal(update.work_ms, create.work_ms);
  assert.equal(update.cost, create.cost);
  assert.equal(update.status, create.status);
  assert.equal(update.ended_at, create.ended_at);
});

test("a create followed by an update never lets the update re-send an assignment field, even with a changed catalog", () => {
  // Simulates the CRITICAL scenario: the task was created while unassigned,
  // the owner reassigns it in the web, and a later re-sync (still using
  // the same local task, whose clientId still does not resolve) must not
  // carry an assignment field at all.
  const task = makeTask({ client: "cajamar" });
  const update = buildTaskEntryUpdatePayload(task, ctx);
  assert.equal(Object.prototype.hasOwnProperty.call(update, "client"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(update, "legacy_client_label"), false);
});

test("buildWorkRecordPayload maps a WorkRecord to the work_records shape, always rollup: false", () => {
  const record = makeRecord({ id: "wr-1", role: "subagent", pid: 200, parentPid: 100 });
  const payload = buildWorkRecordPayload(record, "task-entry-record-id", { machine: "laptop", promptMode: "full" });

  assert.equal(payload.kankaku_id, "wr-1");
  assert.equal(payload.task_entry, "task-entry-record-id");
  assert.equal(payload.rollup, false);
  assert.equal(payload.role, "subagent");
  assert.equal(payload.pid, 200);
  assert.equal(payload.parent_pid, 100);
  assert.equal(payload.started_at, record.startedAt.replace("T", " "));
  assert.equal(payload.settled_at, record.settledAt.replace("T", " "));
  assert.equal(payload.wall_ms, record.wallMs);
  assert.equal(payload.cost, record.usage.cost);
  assert.deepEqual(payload.tools, record.tools);
  assert.equal(payload.prompt, record.prompt);
  assert.equal(payload.machine, "laptop");
  assert.equal(payload.schema, record.schema);
});

test("buildWorkRecordPayload defaults segments to {} for an older record without one", () => {
  const record = makeRecord({ segments: undefined });
  const payload = buildWorkRecordPayload(record, "te-1", { machine: "laptop", promptMode: "none" });
  assert.deepEqual(payload.segments, {});
});

test("taskWorkRecords returns the orchestrator followed by every subagent", () => {
  const orchestrator = makeRecord({ id: "orch" });
  const child = makeRecord({ id: "child", role: "subagent" });
  const task = makeTask({ subagents: [child] }, { id: "orch" });
  assert.deepEqual(
    taskWorkRecords(task).map((record) => record.id),
    ["orch", "child"],
  );
});
