import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiTracker } from "../src/adapters/pi-tracker.ts";
import { WorkTracker } from "../src/domain/work-tracker.ts";
import type { Clock } from "../src/ports/clock.ts";
import type { InflightStore } from "../src/ports/inflight-store.ts";
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

class FakeInflightStore implements InflightStore {
  readonly saved: WorkRecord[] = [];
  clearedCount = 0;
  private readonly staleRecords: WorkRecord[];

  constructor(staleRecords: WorkRecord[] = []) {
    this.staleRecords = staleRecords;
  }

  save(record: WorkRecord): void {
    this.saved.push(record);
  }

  clear(): void {
    this.clearedCount++;
  }

  recoverStale(_isAlive: (pid: number) => boolean): WorkRecord[] {
    return this.staleRecords.splice(0, this.staleRecords.length);
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeCommandOptions {
  handler: (args: string, ctx: unknown) => Promise<void>;
  getArgumentCompletions?: (argumentPrefix: string) => unknown;
}

class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, FakeCommandOptions>();
  readonly entries: Array<{ customType: string; data: unknown }> = [];
  readonly renderers = new Map<string, unknown>();
  sessionName: string | undefined = undefined;

  appendEntry(customType: string, data?: unknown): void {
    this.entries.push({ customType, data });
  }

  getSessionName(): string | undefined {
    return this.sessionName;
  }

  registerEntryRenderer(customType: string, renderer: unknown): void {
    this.renderers.set(customType, renderer);
  }

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerCommand(name: string, options: FakeCommandOptions): void {
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
      getEntries: () => [],
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
    inflight: new FakeInflightStore(),
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

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });

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

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });

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

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });

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
  const inflight = new FakeInflightStore();
  const pi = new FakePi();
  const notified: Array<{ message: string; type?: string }> = [];
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeFakeCtx({
    ui: {
      notify: (message: string, type?: string) => notified.push({ message, type }),
      setStatus: (key: string, value: string | undefined) => statusCalls.push([key, value]),
    },
  });

  createPiTracker(pi as never, { tracker, log, inflight, role: "orchestrator", pid: 1, parentPid: 0 });

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  await assert.doesNotReject(() => pi.fire("agent_settled", { type: "agent_settled" }, ctx));

  assert.equal(notified.length, 1);
  assert.equal(notified[0]?.type, "error");
  // the status timer and the in-flight checkpoint are cleaned up even though log.append threw
  assert.deepEqual(statusCalls.at(-1), ["zz-kankaku", undefined]);
  assert.equal(inflight.clearedCount, 1);
});

test("session_shutdown also clears status and the in-flight checkpoint when log.append throws", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log: WorkLog = {
    append: () => {
      throw new Error("disk full");
    },
    readAll: () => [],
  };
  const inflight = new FakeInflightStore();
  const pi = new FakePi();
  const notified: Array<{ message: string; type?: string }> = [];
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeFakeCtx({
    ui: {
      notify: (message: string, type?: string) => notified.push({ message, type }),
      setStatus: (key: string, value: string | undefined) => statusCalls.push([key, value]),
    },
  });

  createPiTracker(pi as never, { tracker, log, inflight, role: "orchestrator", pid: 1, parentPid: 0 });

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  clock.advanceTo(300);
  await assert.doesNotReject(() => pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx));

  assert.equal(notified.length, 1);
  assert.equal(notified[0]?.type, "error");
  assert.deepEqual(statusCalls.at(-1), ["zz-kankaku", undefined]);
  assert.equal(inflight.clearedCount, 1);
});

test("turn_end with usage missing cost accumulates zero cost", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const inflight = new FakeInflightStore();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, { tracker, log, inflight, role: "orchestrator", pid: 1, parentPid: 0 });

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  await pi.fire(
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: { role: "assistant", usage: { input: 5, output: 1 } }, toolResults: [] },
    ctx,
  );
  clock.advanceTo(10);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(log.records.length, 1);
  assert.equal(log.records[0]?.usage.cost, 0);
  assert.equal(log.records[0]?.usage.input, 5);
  assert.equal(log.records[0]?.usage.output, 1);
});

test("turn_end and tool_execution_end save an in-flight checkpoint with the eventual record's id", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const inflight = new FakeInflightStore();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, { tracker, log, inflight, role: "orchestrator", pid: 1, parentPid: 0 });

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  clock.advanceTo(500);
  await pi.fire(
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } }, toolResults: [] },
    ctx,
  );

  assert.equal(inflight.saved.length, 1);
  assert.equal(inflight.saved[0]?.status, "interrupted");
  assert.equal(inflight.saved[0]?.wallMs, 500);

  clock.advanceTo(700);
  await pi.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} }, ctx);
  clock.advanceTo(900);
  await pi.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {}, isError: false }, ctx);

  assert.equal(inflight.saved.length, 2);

  clock.advanceTo(1000);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(log.records.length, 1);
  assert.equal(inflight.saved[0]?.id, log.records[0]?.id);
  assert.equal(inflight.saved[1]?.id, log.records[0]?.id);
  assert.equal(inflight.clearedCount, 1);
});

test("session_start recovers stale checkpoints into the log and notifies", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const staleRecord = makeRecord({ id: "stale-1", status: "completed" });
  const inflight = new FakeInflightStore([staleRecord]);
  const pi = new FakePi();
  const notified: Array<{ message: string; type?: string }> = [];
  const ctx = makeFakeCtx({ ui: { notify: (message: string, type?: string) => notified.push({ message, type }), setStatus: () => {} } });

  createPiTracker(pi as never, { tracker, log, inflight, role: "orchestrator", pid: 1, parentPid: 0 });

  await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);

  assert.equal(log.records.length, 1);
  assert.equal(log.records[0]?.id, "stale-1");
  assert.equal(notified.length, 1);
  assert.match(notified[0]!.message, /recovered 1/);
  assert.equal(notified[0]!.type, "warning");
});

test("session_start with no stale checkpoints appends nothing and does not notify", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const inflight = new FakeInflightStore();
  const pi = new FakePi();
  const notified: Array<{ message: string; type?: string }> = [];
  const ctx = makeFakeCtx({ ui: { notify: (message: string, type?: string) => notified.push({ message, type }), setStatus: () => {} } });

  createPiTracker(pi as never, { tracker, log, inflight, role: "orchestrator", pid: 1, parentPid: 0 });

  await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);

  assert.equal(log.records.length, 0);
  assert.equal(notified.length, 0);
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

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });

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

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });
  await pi.commands.get("kankaku")!.handler("tasks", ctx);

  assert.equal(pi.entries.length, 0);
  assert.equal(notified.length, 1);
  assert.match(notified[0]!, /no tasks/);
});

test("createPiTracker registers the kankaku-report entry renderer", () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const pi = new FakePi();
  createPiTracker(pi as never, { tracker, log: new FakeWorkLog(), inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });
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

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });

  const command = pi.commands.get("kankaku");
  assert.ok(command);
  await command!.handler("sessions all", ctx);

  assert.equal(notified.length, 0);
  assert.equal(pi.entries.length, 1);
  const lines = (pi.entries[0]!.data as { lines: string[] }).lines;
  assert.match(lines[0]!, /^session-/); // sessionId truncated to its first 8 chars
  assert.match(lines[0]!, /tasks 1/);
});

test("buildRecord fills client from env config and sessionName from pi.getSessionName()", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  pi.sessionName = "billing sprint";
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, {
    tracker,
    log,
    inflight: new FakeInflightStore(),
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    envClient: "acme",
    resolveProjectClient: () => undefined,
  });

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  clock.advanceTo(10);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(log.records.length, 1);
  assert.equal(log.records[0]?.client, "acme");
  assert.equal(log.records[0]?.sessionName, "billing sprint");
});

test("buildRecord falls back to the project client when env and session are absent", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, {
    tracker,
    log,
    inflight: new FakeInflightStore(),
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    resolveProjectClient: () => "initech",
  });

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  clock.advanceTo(10);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(log.records[0]?.client, "initech");
});

test("session_start restores the session client from the last kankaku-client custom entry, taking precedence over env", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const entries = [
    { type: "custom", customType: "kankaku-client", data: { client: "old-client" } },
    { type: "message", data: {} },
    { type: "custom", customType: "kankaku-client", data: { client: "acme" } },
  ];
  const ctx = makeFakeCtx({
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/abs/project/path/.pi/sessions/session-1.json",
      getEntries: () => entries,
    },
  });

  createPiTracker(pi as never, {
    tracker,
    log,
    inflight: new FakeInflightStore(),
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    envClient: "globex",
  });

  await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  clock.advanceTo(10);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(log.records[0]?.client, "acme");
});

test("session_start restores an undefined session client when the last kankaku-client entry cleared it", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const entries = [
    { type: "custom", customType: "kankaku-client", data: { client: "acme" } },
    { type: "custom", customType: "kankaku-client", data: { client: undefined } },
  ];
  const ctx = makeFakeCtx({
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/abs/project/path/.pi/sessions/session-1.json",
      getEntries: () => entries,
    },
  });

  createPiTracker(pi as never, {
    tracker,
    log,
    inflight: new FakeInflightStore(),
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    envClient: "globex",
  });

  await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  clock.advanceTo(10);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(log.records[0]?.client, "globex");
});

test("'kankaku client <name>' sets the session client, persists it, and confirms via the durable report card", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });

  const command = pi.commands.get("kankaku");
  assert.ok(command);
  await command!.handler("client acme", ctx);

  assert.equal(pi.entries.length, 2);
  assert.equal(pi.entries[0]!.customType, "kankaku-client");
  assert.deepEqual(pi.entries[0]!.data, { client: "acme" });
  assert.equal(pi.entries[1]!.customType, "kankaku-report");
  const report = pi.entries[1]!.data as { lines: string[] };
  assert.match(report.lines.join("\n"), /acme/);

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  clock.advanceTo(10);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(log.records[0]?.client, "acme");
});

test("'kankaku client' rejects an invalid name and notifies without setting or persisting anything", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const notified: Array<{ message: string; type?: string }> = [];
  const ctx = makeFakeCtx({ ui: { notify: (message: string, type?: string) => notified.push({ message, type }), setStatus: () => {} } });

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });

  const command = pi.commands.get("kankaku");
  await command!.handler("client not valid!", ctx);

  assert.equal(pi.entries.length, 0);
  assert.equal(notified.length, 1);
  assert.equal(notified[0]?.type, "error");
});

test("'kankaku client' with no argument shows the effective client and its source", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, {
    tracker,
    log,
    inflight: new FakeInflightStore(),
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    envClient: "globex",
  });

  const command = pi.commands.get("kankaku");
  await command!.handler("client", ctx);

  assert.equal(pi.entries.length, 1);
  const data = pi.entries[0]!.data as { lines: string[] };
  const text = data.lines.join("\n");
  assert.match(text, /globex/);
  assert.match(text, /env/);
});

test("'kankaku client' shows no client when none of the sources resolve", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });

  const command = pi.commands.get("kankaku");
  await command!.handler("client", ctx);

  const data = pi.entries[0]!.data as { lines: string[] };
  assert.match(data.lines.join("\n"), /none/i);
});

test("'kankaku client --clear' clears the session client label and falls back to the next source", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, {
    tracker,
    log,
    inflight: new FakeInflightStore(),
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    envClient: "globex",
  });

  const command = pi.commands.get("kankaku");
  await command!.handler("client acme", ctx);
  await command!.handler("client --clear", ctx);

  const clientEntries = pi.entries.filter((entry) => entry.customType === "kankaku-client");
  assert.deepEqual(clientEntries.at(-1)!.data, { client: undefined });

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  clock.advanceTo(10);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(log.records[0]?.client, "globex");
});

test("kankaku command exposes getArgumentCompletions offering the known subcommands", async () => {
  const pi = new FakePi();
  createPiTracker(pi as never, {
    tracker: new WorkTracker({ clock: new FakeClock(0), interactiveTools: [], subagentTool: "subagent_run" }),
    log: new FakeWorkLog(),
    inflight: new FakeInflightStore(),
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
  });

  const command = pi.commands.get("kankaku");
  assert.ok(command?.getArgumentCompletions);
  const items = (await command!.getArgumentCompletions!("")) as Array<{ value: string }>;
  assert.deepEqual(
    items.map((item) => item.value).sort(),
    ["all", "client", "clients", "export", "sessions", "tasks"],
  );
});

test("kankaku command's getArgumentCompletions offers distinct client names after 'client '", async () => {
  const log = new FakeWorkLog();
  log.append(makeRecord({ id: "r1", client: "acme" }));
  log.append(makeRecord({ id: "r2", client: "globex", pid: 2 }));
  log.append(makeRecord({ id: "r3", client: "acme", pid: 3 }));
  const pi = new FakePi();
  createPiTracker(pi as never, {
    tracker: new WorkTracker({ clock: new FakeClock(0), interactiveTools: [], subagentTool: "subagent_run" }),
    log,
    inflight: new FakeInflightStore(),
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
  });

  const command = pi.commands.get("kankaku");
  const items = (await command!.getArgumentCompletions!("client ")) as Array<{ value: string }>;
  assert.deepEqual(
    items.map((item) => item.value),
    ["acme", "globex"],
  );
});

test("'kankaku clients' appends a durable report entry with per-client totals for today", async () => {
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
    client: "acme",
    startedAt: new Date(now).toISOString(),
    settledAt: new Date(now + 30000).toISOString(),
    wallMs: 30000,
    waitingMs: 0,
    workMs: 30000,
  });
  log.append(parent);

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });

  const command = pi.commands.get("kankaku");
  await command!.handler("clients", ctx);

  assert.equal(notified.length, 0);
  assert.equal(pi.entries.length, 1);
  const data = pi.entries[0]!.data as { title: string; lines: string[] };
  assert.match(data.title, /clients/);
  assert.match(data.lines.join("\n"), /acme/);
});

test("'kankaku export' writes today's tasks as CSV by default and confirms via the durable report card", async () => {
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
    startedAt: new Date(now).toISOString(),
    settledAt: new Date(now + 30000).toISOString(),
  });
  log.append(parent);

  const written: Array<{ name: string; content: string }> = [];
  const writeExportFile = (name: string, content: string): string => {
    written.push({ name, content });
    return `/abs/project/path/.kankaku/export/${name}`;
  };

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0, writeExportFile });

  const command = pi.commands.get("kankaku");
  await command!.handler("export", ctx);

  assert.equal(notified.length, 0);
  assert.equal(written.length, 1);
  const today = new Date(now).toISOString().slice(0, 10);
  assert.equal(written[0]!.name, `tasks-${today}.csv`);
  assert.match(written[0]!.content, /^id,day,startedAt/);

  assert.equal(pi.entries.length, 1);
  const data = pi.entries[0]!.data as { title: string; lines: string[] };
  assert.match(data.title, /export/);
  assert.match(data.lines.join("\n"), /1 row/);
  assert.match(data.lines.join("\n"), new RegExp(`export/tasks-${today}\\.csv`));
});

test("'kankaku export json all' writes every task as JSON with the 'all' filename suffix", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  const parentOld = makeRecord({
    id: "p1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    startedAt: "2020-01-01T00:00:00.000Z",
    settledAt: "2020-01-01T00:00:30.000Z",
  });
  log.append(parentOld);

  const written: Array<{ name: string; content: string }> = [];
  const writeExportFile = (name: string, content: string): string => {
    written.push({ name, content });
    return `/abs/export/${name}`;
  };

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0, writeExportFile });

  const command = pi.commands.get("kankaku");
  await command!.handler("export json all", ctx);

  assert.equal(written.length, 1);
  assert.equal(written[0]!.name, "tasks-all.json");
  assert.deepEqual(JSON.parse(written[0]!.content)[0]?.id, "p1");
});

test("'kankaku export' notifies an error when export is not configured", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const notified: Array<{ message: string; type?: string }> = [];
  const ctx = makeFakeCtx({ ui: { notify: (message: string, type?: string) => notified.push({ message, type }), setStatus: () => {} } });

  createPiTracker(pi as never, { tracker, log, inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });

  const command = pi.commands.get("kankaku");
  await command!.handler("export", ctx);

  assert.equal(pi.entries.length, 0);
  assert.equal(notified.length, 1);
  assert.equal(notified[0]?.type, "error");
});

test("a subagent record never carries a client even when env and project sources resolve", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const ctx = makeFakeCtx();

  createPiTracker(pi as never, {
    tracker,
    log,
    inflight: new FakeInflightStore(),
    role: "subagent",
    pid: 2,
    parentPid: 1,
    envClient: "acme",
    resolveProjectClient: () => "initech",
  });

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "child work", systemPrompt: "", systemPromptOptions: {} }, ctx);
  clock.advanceTo(10);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(log.records.length, 1);
  assert.equal(log.records[0]?.role, "subagent");
  assert.equal("client" in log.records[0]!, false);
});

test("the status line shows a clock emoji followed by a space and mm:ss", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const pi = new FakePi();
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeFakeCtx({
    ui: { notify: () => {}, setStatus: (key: string, value: string | undefined) => statusCalls.push([key, value]) },
  });

  createPiTracker(pi as never, { tracker, log: new FakeWorkLog(), inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });
  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);

  assert.deepEqual(statusCalls[0], ["zz-kankaku", "🕒 00:00"]);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);
});

test("the project client is read once per run, not on every checkpoint", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const log = new FakeWorkLog();
  const pi = new FakePi();
  const ctx = makeFakeCtx();
  let reads = 0;

  createPiTracker(pi as never, {
    tracker,
    log,
    inflight: new FakeInflightStore(),
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    resolveProjectClient: () => {
      reads += 1;
      return "initech";
    },
  });

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  for (let i = 0; i < 3; i += 1) {
    clock.advanceTo(10 * (i + 1));
    await pi.fire("turn_end", { type: "turn_end", turnIndex: i, message: { role: "assistant", content: [] }, toolResults: [] }, ctx);
  }
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(reads, 1);
  assert.equal(log.records[0]?.client, "initech");
});

test("the status line shows the client next to the elapsed time when one resolves", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const pi = new FakePi();
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeFakeCtx({
    ui: { notify: () => {}, setStatus: (key: string, value: string | undefined) => statusCalls.push([key, value]) },
  });

  createPiTracker(pi as never, {
    tracker,
    log: new FakeWorkLog(),
    inflight: new FakeInflightStore(),
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    envClient: "acme",
  });
  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);

  assert.deepEqual(statusCalls[0], ["zz-kankaku", "🕒 00:00 · acme"]);
  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.deepEqual(statusCalls.at(-1), ["zz-kankaku", "🏷 acme"]);
});

test("the client stays visible in the status bar while idle, and clears when no client resolves", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const pi = new FakePi();
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeFakeCtx({
    ui: { notify: () => {}, setStatus: (key: string, value: string | undefined) => statusCalls.push([key, value]) },
  });

  createPiTracker(pi as never, {
    tracker,
    log: new FakeWorkLog(),
    inflight: new FakeInflightStore(),
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    envClient: "acme",
  });

  await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.deepEqual(statusCalls.at(-1), ["zz-kankaku", "🏷 acme"]);

  await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "p", systemPrompt: "", systemPromptOptions: {} }, ctx);
  assert.deepEqual(statusCalls.at(-1), ["zz-kankaku", "🕒 00:00 · acme"]);

  await pi.fire("agent_settled", { type: "agent_settled" }, ctx);
  assert.deepEqual(statusCalls.at(-1), ["zz-kankaku", "🏷 acme"]);

  await pi.commands.get("kankaku")!.handler("client globex", ctx);
  assert.deepEqual(statusCalls.at(-1), ["zz-kankaku", "🏷 globex"]);

  await pi.commands.get("kankaku")!.handler("client --clear", ctx);
  assert.deepEqual(statusCalls.at(-1), ["zz-kankaku", "🏷 acme"]);
});

test("no idle status is shown when no client resolves", async () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentTool: "subagent_run" });
  const pi = new FakePi();
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeFakeCtx({
    ui: { notify: () => {}, setStatus: (key: string, value: string | undefined) => statusCalls.push([key, value]) },
  });

  createPiTracker(pi as never, { tracker, log: new FakeWorkLog(), inflight: new FakeInflightStore(), role: "orchestrator", pid: 1, parentPid: 0 });
  await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.deepEqual(statusCalls.at(-1), ["zz-kankaku", undefined]);
});
