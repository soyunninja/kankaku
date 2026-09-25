import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createExportScreen } from "../src/adapters/panel/screens/export.ts";
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
  return { hasUI: true } as unknown as ExtensionContext;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("defaults to csv/today", () => {
  const factory = createExportScreen({ log: new FakeWorkLog(), ctx: makeCtx(), pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  const lines = component.render(100).join("\n");
  assert.match(lines, /Format\s+csv/);
  assert.match(lines, /Range\s+today/);
});

test("cycling the format row switches csv -> json", () => {
  const factory = createExportScreen({ log: new FakeWorkLog(), ctx: makeCtx(), pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(ENTER); // "format" is the topmost row
  assert.match(component.render(100).join("\n"), /Format\s+json/);
});

test("cycling the range row switches today -> all", () => {
  const factory = createExportScreen({ log: new FakeWorkLog(), ctx: makeCtx(), pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(DOWN); // format -> range
  component.handleInput(ENTER);
  assert.match(component.render(100).join("\n"), /Range\s+all/);
});

test("'write file' computes the export content for the current format/range and reports the written path", async () => {
  const log = new FakeWorkLog();
  const today = new Date().toISOString();
  log.append(makeRecord({ startedAt: today, settledAt: today }));
  const written: Array<{ name: string; content: string }> = [];
  const writeExportFile = (name: string, content: string) => {
    written.push({ name, content });
    return `/abs/.kankaku/export/${name}`;
  };

  const factory = createExportScreen({ log, writeExportFile, ctx: makeCtx(), pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(DOWN); // format -> range
  component.handleInput(DOWN); // range -> write
  component.handleInput(ENTER);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(written.length, 1);
  assert.match(written[0]!.name, /^tasks-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(component.render(100).join("\n"), /wrote \/abs\/\.kankaku\/export\/tasks-\d{4}-\d{2}-\d{2}\.csv/);
});

test("'write file' uses the currently selected format/range", async () => {
  const log = new FakeWorkLog();
  log.append(makeRecord({ startedAt: "2020-01-01T00:00:00.000Z", settledAt: "2020-01-01T00:00:05.000Z" }));
  const written: Array<{ name: string; content: string }> = [];
  const writeExportFile = (name: string, content: string) => {
    written.push({ name, content });
    return `/abs/${name}`;
  };

  const factory = createExportScreen({ log, writeExportFile, ctx: makeCtx(), pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(ENTER); // format: csv -> json
  component.handleInput(DOWN); // format -> range
  component.handleInput(ENTER); // range: today -> all
  component.handleInput(DOWN); // range -> write
  component.handleInput(ENTER);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(written[0]!.name, "tasks-all.json");
  const parsed = JSON.parse(written[0]!.content) as unknown[];
  assert.equal(parsed.length, 1);
});

test("'write file' returns the subcommand's own message when writeExportFile is not configured", async () => {
  const factory = createExportScreen({ log: new FakeWorkLog(), ctx: makeCtx(), pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(DOWN); // format -> range
  component.handleInput(DOWN); // range -> write
  component.handleInput(ENTER);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.match(component.render(100).join("\n"), /export is not configured/);
});

test("'pin' pins an export report", async () => {
  const pinned: KankakuReportData[] = [];
  const factory = createExportScreen({ log: new FakeWorkLog(), ctx: makeCtx(), pinReport: (report) => pinned.push(report) });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(DOWN); // format -> range
  component.handleInput(DOWN); // range -> write
  component.handleInput(DOWN); // write -> pin
  component.handleInput(ENTER);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(pinned.length, 1);
  assert.equal(pinned[0]!.title, "export");
});
