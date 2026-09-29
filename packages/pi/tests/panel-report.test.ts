import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createReportScreen } from "../src/adapters/panel/screens/report.ts";
import type { KankakuReportData } from "../src/adapters/kankaku-command.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";
import type { WorkLog } from "../src/ports/work-log.ts";
import { DOWN, ENTER, fakeHost } from "./helpers/panel-fakes.ts";

type TestComponent = Component & { handleInput: NonNullable<Component["handleInput"]> };

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/abs/project",
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

class FakeWorkLog implements WorkLog {
  readonly records: WorkRecord[] = [];
  append(record: WorkRecord): void {
    this.records.push(record);
  }
  readAll(): WorkRecord[] {
    return this.records;
  }
}

function makeCtx(): ExtensionContext {
  return { hasUI: true, sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionContext;
}

function makePi(): ExtensionAPI {
  return {} as unknown as ExtensionAPI;
}

test("defaults to the summary view, today's range, and renders its lines", () => {
  const log = new FakeWorkLog();
  const today = new Date().toISOString();
  log.append(makeRecord({ startedAt: today, settledAt: today }));

  const factory = createReportScreen({ log, ctx: makeCtx(), pi: makePi(), pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  const lines = component.render(100).join("\n");
  assert.match(lines, /View\s+summary/);
  assert.match(lines, /Range\s+today/);
  assert.match(lines, /orchestrator: work/);
});

test("cycling the view row switches to tasks and rebuilds the body", () => {
  const log = new FakeWorkLog();
  log.append(makeRecord({ sessionId: "session-1", prompt: "the task prompt" }));

  const factory = createReportScreen({ log, ctx: makeCtx(), pi: makePi(), sessionId: () => "session-1", pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(ENTER); // "view" is the topmost row: summary -> tasks
  const lines = component.render(100).join("\n");
  assert.match(lines, /View\s+tasks/);
  assert.match(lines, /the task prompt/);
});

test("cycling the range row from today to all rebuilds the body", () => {
  const log = new FakeWorkLog();
  log.append(makeRecord({ client: "acme", startedAt: "2020-01-01T00:00:00.000Z", settledAt: "2020-01-01T00:00:05.000Z" }));

  const factory = createReportScreen({ log, ctx: makeCtx(), pi: makePi(), pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(DOWN); // view -> range
  component.handleInput(ENTER); // today -> all
  const lines = component.render(100).join("\n");
  assert.match(lines, /Range\s+all/);
  assert.match(lines, /1 uncertain record\(s\)|orchestrator: work/); // summary view still renders (range changed, view unchanged)
});

test("scope only applies to the tasks view: it shows 'n/a' for the default summary view", () => {
  const log = new FakeWorkLog();
  const factory = createReportScreen({ log, ctx: makeCtx(), pi: makePi(), pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  const lines = component.render(100).join("\n");
  assert.match(lines, /Scope\s+n\/a/);
});

test("switching to the tasks view makes scope cycle between session and all sessions", () => {
  const log = new FakeWorkLog();
  log.append(makeRecord({ id: "rec-a", pid: 1, sessionId: "session-1", prompt: "mine" }));
  log.append(makeRecord({ id: "rec-b", pid: 2, sessionId: "session-2", prompt: "someone else's" }));

  const factory = createReportScreen({ log, ctx: makeCtx(), pi: makePi(), sessionId: () => "session-1", pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(ENTER); // view: summary -> tasks
  let lines = component.render(100).join("\n");
  assert.match(lines, /Scope\s+session/);
  assert.match(lines, /mine/);
  assert.doesNotMatch(lines, /someone else's/);

  component.handleInput(DOWN); // view -> range
  component.handleInput(DOWN); // range -> scope
  component.handleInput(ENTER); // session -> all sessions
  lines = component.render(100).join("\n");
  assert.match(lines, /Scope\s+all sessions/);
  assert.match(lines, /mine/);
  assert.match(lines, /someone else's/);
});

test("'pin to chat' calls pinReport with the current view's report and shows a confirmation", async () => {
  const log = new FakeWorkLog();
  const pinned: KankakuReportData[] = [];
  const factory = createReportScreen({ log, ctx: makeCtx(), pi: makePi(), pinReport: (report) => pinned.push(report) });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(DOWN); // view -> range
  component.handleInput(DOWN); // range -> scope
  component.handleInput(DOWN); // scope -> pin
  component.handleInput(ENTER); // run it

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pinned.length, 1);
  assert.equal(pinned[0]!.title, "summary (today)");
  assert.match(component.render(100).join("\n"), /pinned to the chat transcript/);
});
