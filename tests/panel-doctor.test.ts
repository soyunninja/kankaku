import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createDoctorScreen } from "../src/adapters/panel/screens/doctor.ts";
import type { KankakuCommandDeps, KankakuReportData } from "../src/adapters/kankaku-command.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";
import type { WorkLog } from "../src/ports/work-log.ts";
import { DOWN, ENTER, ESCAPE, fakeHost } from "./helpers/panel-fakes.ts";

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

test("renders buildDoctorLines' output in the body", () => {
  const log = new FakeWorkLog();
  log.append(makeRecord({ id: "c1", role: "subagent", pid: 2, parentPid: 999 }));
  const commandDeps: KankakuCommandDeps = { log, sessionClient: undefined as never, refreshIdleStatus: () => {} };
  const factory = createDoctorScreen({ commandDeps, ctx: makeCtx(), pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  const lines = component.render(100).join("\n");
  assert.match(lines, /orphan subagent record\(s\): 1/);
  assert.match(lines, /ancestor-chain detection:/);
});

test("'refresh' re-runs buildDoctorLines against the current log", async () => {
  const log = new FakeWorkLog();
  const commandDeps: KankakuCommandDeps = { log, sessionClient: undefined as never, refreshIdleStatus: () => {} };
  const factory = createDoctorScreen({ commandDeps, ctx: makeCtx(), pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  assert.doesNotMatch(component.render(100).join("\n"), /orphan subagent record\(s\): 1/);

  log.append(makeRecord({ id: "c1", role: "subagent", pid: 2, parentPid: 999 }));
  component.handleInput(DOWN); // pin -> refresh
  component.handleInput(ENTER); // run refresh
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(component.render(100).join("\n"), /orphan subagent record\(s\): 1/);
});

test("'pin to chat' calls pinReport with the doctor lines, titled 'doctor'", async () => {
  const log = new FakeWorkLog();
  const pinned: KankakuReportData[] = [];
  const commandDeps: KankakuCommandDeps = { log, sessionClient: undefined as never, refreshIdleStatus: () => {} };
  const factory = createDoctorScreen({ commandDeps, ctx: makeCtx(), pinReport: (report) => pinned.push(report) });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(ENTER); // "pin" is the first row
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pinned.length, 1);
  assert.equal(pinned[0]!.title, "doctor");
  assert.match(component.render(100).join("\n"), /pinned to the chat transcript/);
});

test("escape from the doctor screen's list goes back", () => {
  const log = new FakeWorkLog();
  const commandDeps: KankakuCommandDeps = { log, sessionClient: undefined as never, refreshIdleStatus: () => {} };
  const factory = createDoctorScreen({ commandDeps, ctx: makeCtx(), pinReport: () => {} });
  const host = fakeHost();
  const component = factory(host) as TestComponent;

  component.handleInput(DOWN);
  component.handleInput(ESCAPE);
  assert.equal(host.backCalls, 1);
});
