import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiTracker } from "../src/adapters/pi-tracker.ts";
import { WorkTracker } from "../src/domain/work-tracker.ts";
import type { Clock } from "../src/ports/clock.ts";
import type { WorkLog } from "../src/ports/work-log.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/abs/project/path",
    prompt: "hello",
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    wallMs: 0,
    waitingMs: 0,
    workMs: 0,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    status: "completed",
    ...overrides,
  };
}

class FakeClock implements Clock {
  private current: number;
  constructor(start: number) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advanceTo(ms: number): void {
    this.current = ms;
  }
}

class FakeWorkLog implements WorkLog {
  readonly records: WorkRecord[] = [];
  append(record: WorkRecord): void {
    this.records.push(record);
  }
  readAll(): WorkRecord[] {
    return this.records;
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  readonly entries: Array<{ customType: string; data: unknown }> = [];
  readonly renderers = new Map<string, unknown>();

  appendEntry(customType: string, data?: unknown): void {
    this.entries.push({ customType, data });
  }

  registerEntryRenderer(customType: string, renderer: unknown): void {
    this.renderers.set(customType, renderer);
  }

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }): void {
    this.commands.set(name, options);
  }

  async fire(event: string, payload: unknown, ctx: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }
}

function makeFakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/abs/project/path",
    mode: "tui",
    hasUI: true,
    model: { provider: "anthropic", id: "claude-opus" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/abs/project/path/.pi/sessions/session-1.json",
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
    ...overrides,
  };
}

test("a full run with a subagent call and an interactive tool appends exactly one record", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({
    clock,
    interactiveTools: ["ask_user_question", "ask_user_choice"],
    subagentTool: "subagent_run",
  });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, {
    tracker,
    log,
    role: "orchestrator",
    pid: 4242,
    parentPid: 4000,
  });

  clock.advanceTo(0);
  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "do the thing", systemPrompt: "", systemPromptOptions: {} }, ctx);

  clock.advanceTo(500);
  await pi.fire(
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: { role: "assistant", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0.01 } } }, toolResults: [] },
    ctx,
  );

  clock.advanceTo(1000);
  await pi.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "call-1", toolName: "subagent_run", args: { agent: "sdd-explore", mode: "task" } }, ctx);

  clock.advanceTo(9000);
  await pi.fire(
    "tool_execution_end",
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "subagent_run", result: { details: { gentleAgents: { taskId: "t1" } } }, isError: false },
    ctx,
  );

  clock.advanceTo(9500);
  await pi.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "call-2", toolName: "ask_user_question", args: {} }, ctx);

  clock.advanceTo(9600);
  await pi.fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "select" }, ctx);

  clock.advanceTo(19600);
  await pi.fire("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "select" }, ctx);

  clock.advanceTo(19700);
  await pi.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "call-2", toolName: "ask_user_question", result: {}, isError: false }, ctx);

  clock.advanceTo(20000);
  await pi.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);

  clock.advanceTo(20100);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(log.records.length, 1);
  const record = log.records[0]!;

  assert.equal(record.role, "orchestrator");
  assert.equal(record.pid, 4242);
  assert.equal(record.parentPid, 4000);
  assert.equal(record.project, "/abs/project/path");
  assert.equal(record.sessionId, "session-1");
  assert.equal(record.sessionFile, "/abs/project/path/.pi/sessions/session-1.json");
  assert.equal(record.mode, "tui");
  assert.equal(record.model, "anthropic/claude-opus");
  assert.equal(record.prompt, "do the thing");
  assert.equal(record.status, "completed");
  assert.equal(record.wallMs, 20100);
  // waiting = union of the tool span [9500,19700] and ui prompt span [9600,19600] = [9500,19700] = 10200ms
  assert.equal(record.waitingMs, 10200);
  assert.equal(record.workMs, 20100 - 10200);
  assert.equal(record.tools["subagent_run"], 1);
  assert.equal(record.tools["ask_user_question"], 1);
  assert.equal(record.subagents.length, 1);
  assert.equal(record.subagents[0]?.taskId, "t1");
  assert.equal(record.subagents[0]?.agent, "sdd-explore");
  assert.equal(record.usage.input, 10);
});

test("session_shutdown while running appends an interrupted record", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, { tracker, log, role: "orchestrator", pid: 1, parentPid: 0 });

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  clock.advanceTo(300);
  await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

  assert.equal(log.records.length, 1);
  assert.equal(log.records[0]?.status, "interrupted");
});

test("session_shutdown while idle appends nothing", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, { tracker, log, role: "orchestrator", pid: 1, parentPid: 0 });

  await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

  assert.equal(log.records.length, 0);
});

test("registers a kankaku command that appends a durable summary entry", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const notified: string[] = [];
  const ctx = makeFakeCtx({ ui: { notify: (msg: string) => notified.push(msg), setStatus: () => {} } });

  createPiTracker(pi as never, { tracker, log, role: "orchestrator", pid: 1, parentPid: 0 });

  const command = pi.commands.get("kankaku");
  assert.ok(command);
  await command!.handler("", ctx);

  assert.equal(notified.length, 0);
  assert.equal(pi.entries.length, 1);
  const data = pi.entries[0]!.data as { title: string; lines: string[] };
  assert.match(data.title, /today/);
  assert.match(data.lines.join("\n"), /orchestrator/i);
});

test("a handler failure does not throw and notifies ui when available", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log: WorkLog = {
    append: () => {
      throw new Error("disk full");
    },
    readAll: () => [],
  };
  const pi = new FakePi();
  const notified: Array<{ message: string; type?: string }> = [];
  const ctx = makeFakeCtx({ ui: { notify: (message: string, type?: string) => notified.push({ message, type }), setStatus: () => {} } });

  createPiTracker(pi as never, { tracker, log, role: "orchestrator", pid: 1, parentPid: 0 });

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  await assert.doesNotReject(() => pi.fire("agent_settled", { type: "agent_settled" }, ctx));

  assert.equal(notified.length, 1);
  assert.equal(notified[0]?.type, "error");
});

test("'kankaku tasks' appends a durable report entry for the current session, unioning a background child's span", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const notified: string[] = [];
  const ctx = makeFakeCtx({ ui: { notify: (msg: string) => notified.push(msg), setStatus: () => {} } });

  const now = Date.now();
  const parent = makeRecord({
    id: "p1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    sessionId: "session-1",
    prompt: "launch background subagents",
    startedAt: new Date(now).toISOString(),
    settledAt: new Date(now + 30000).toISOString(),
    wallMs: 30000,
    waitingMs: 0,
    workMs: 30000,
  });
  const child = makeRecord({
    id: "c1",
    role: "subagent",
    pid: 200,
    parentPid: 100,
    sessionId: "session-1-child",
    startedAt: new Date(now + 10000).toISOString(),
    settledAt: new Date(now + 45000).toISOString(),
    wallMs: 35000,
    waitingMs: 0,
    workMs: 35000,
  });
  const otherSessionTask = makeRecord({
    id: "p2",
    role: "orchestrator",
    pid: 300,
    parentPid: 1,
    sessionId: "session-2",
    prompt: "unrelated session",
    startedAt: new Date(now).toISOString(),
    settledAt: new Date(now + 5000).toISOString(),
    wallMs: 5000,
    waitingMs: 0,
    workMs: 5000,
  });
  log.append(parent);
  log.append(child);
  log.append(otherSessionTask);

  createPiTracker(pi as never, { tracker, log, role: "orchestrator", pid: 1, parentPid: 0 });

  const command = pi.commands.get("kankaku");
  assert.ok(command);
  await command!.handler("tasks", ctx);

  assert.equal(notified.length, 0);
  assert.equal(pi.entries.length, 1);
  assert.equal(pi.entries[0]!.customType, "kankaku-report");
  const data = pi.entries[0]!.data as { title: string; lines: string[] };
  assert.match(data.title, /tasks/);
  const body = data.lines.join("\n");
  assert.match(body, /subagents 1/);
  assert.match(body, /launch background subagents/);
  assert.doesNotMatch(body, /unrelated session/);

  await command!.handler("tasks all", ctx);
  const allBody = (pi.entries[1]!.data as { lines: string[] }).lines.join("\n");
  assert.match(allBody, /unrelated session/);
});

test("'kankaku' falls back to notify when no UI is available", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const notified: string[] = [];
  const ctx = makeFakeCtx({ hasUI: false, ui: { notify: (msg: string) => notified.push(msg), setStatus: () => {} } });

  createPiTracker(pi as never, { tracker, log, role: "orchestrator", pid: 1, parentPid: 0 });
  await pi.commands.get("kankaku")!.handler("tasks", ctx);

  assert.equal(pi.entries.length, 0);
  assert.equal(notified.length, 1);
  assert.match(notified[0]!, /no tasks/);
});

test("createPiTracker registers the kankaku-report entry renderer", () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const pi = new FakePi();
  createPiTracker(pi as never, { tracker, log: new FakeWorkLog(), role: "orchestrator", pid: 1, parentPid: 0 });
  assert.ok(pi.renderers.has("kankaku-report"));
});

test("'kankaku sessions all' appends a durable report entry with sessions across every day", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const notified: string[] = [];
  const ctx = makeFakeCtx({ ui: { notify: (msg: string) => notified.push(msg), setStatus: () => {} } });

  const parent = makeRecord({
    id: "p1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    sessionId: "session-1",
    startedAt: "2020-01-01T00:00:00.000Z",
    settledAt: "2020-01-01T00:00:30.000Z",
    wallMs: 30000,
    waitingMs: 0,
    workMs: 30000,
  });
  const child = makeRecord({
    id: "c1",
    role: "subagent",
    pid: 200,
    parentPid: 100,
    startedAt: "2020-01-01T00:00:10.000Z",
    settledAt: "2020-01-01T00:00:45.000Z",
  });
  log.append(parent);
  log.append(child);

  createPiTracker(pi as never, { tracker, log, role: "orchestrator", pid: 1, parentPid: 0 });

  const command = pi.commands.get("kankaku");
  assert.ok(command);
  await command!.handler("sessions all", ctx);

  assert.equal(notified.length, 0);
  assert.equal(pi.entries.length, 1);
  const lines = (pi.entries[0]!.data as { lines: string[] }).lines;
  assert.match(lines[0]!, /^session-/); // sessionId truncated to its first 8 chars
  assert.match(lines[0]!, /tasks 1/);
});
