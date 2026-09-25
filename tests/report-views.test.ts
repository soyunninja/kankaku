import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClientsView, buildExportContent, buildProjectsView, buildSessionsView, buildSummaryView, buildTasksView } from "../src/adapters/report-views.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

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

test("buildSummaryView titles by range and appends the uncertain-record hint", () => {
  const today = new Date().toISOString();
  const records = [makeRecord({ startedAt: today, settledAt: today }), makeRecord({ startedAt: today, settledAt: today, roleConfidence: "uncertain" })];

  const todayReport = buildSummaryView(records, { all: false });
  assert.equal(todayReport.title, "summary (today)");
  assert.ok(todayReport.lines.some((line) => line.includes("1 uncertain record(s) excluded")));

  const allReport = buildSummaryView(records, { all: true });
  assert.equal(allReport.title, "summary (all days)");
});

test("buildClientsView groups tasks by client and titles by range", () => {
  const today = new Date().toISOString();
  const records = [makeRecord({ startedAt: today, settledAt: today, client: "acme" })];

  const report = buildClientsView(records, { all: false });
  assert.equal(report.title, "clients (today)");
  assert.ok(report.lines.some((line) => line.startsWith("acme")));
});

test("buildProjectsView groups tasks by project and titles by range", () => {
  const today = new Date().toISOString();
  const records = [makeRecord({ startedAt: today, settledAt: today })];

  const report = buildProjectsView(records, { all: false });
  assert.equal(report.title, "projects (today)");
  assert.ok(report.lines.length > 0);
});

test("buildSessionsView groups tasks by session and titles by range", () => {
  const today = new Date().toISOString();
  const records = [makeRecord({ startedAt: today, settledAt: today, sessionId: "session-1" })];

  const report = buildSessionsView(records, { all: false });
  assert.equal(report.title, "sessions (today)");
  assert.ok(report.lines.length > 0);
});

test("buildTasksView scopes to the given sessionId unless scoped, and titles accordingly", () => {
  const records = [
    makeRecord({ id: "rec-a", pid: 1, sessionId: "session-1", prompt: "task a" }),
    makeRecord({ id: "rec-b", pid: 2, sessionId: "session-2", prompt: "task b" }),
  ];

  const scopedReport = buildTasksView(records, { all: false, sessionId: "session-1" });
  assert.equal(scopedReport.title, "tasks (this session)");
  assert.match(scopedReport.lines.join("\n"), /task a/);
  assert.doesNotMatch(scopedReport.lines.join("\n"), /task b/);

  const everyReport = buildTasksView(records, { all: true, sessionId: "session-1" });
  assert.equal(everyReport.title, "tasks (every session)");
  assert.match(everyReport.lines.join("\n"), /task a/);
  assert.match(everyReport.lines.join("\n"), /task b/);
});

test("buildTasksView scopes to every session when no sessionId is available", () => {
  const records = [makeRecord({ sessionId: "session-1", prompt: "task a" })];

  const report = buildTasksView(records, { all: false, sessionId: undefined });
  assert.equal(report.title, "tasks (every session)");
});

test("buildExportContent names the file by range/format and renders csv/json content with the row count", () => {
  const today = new Date().toISOString();
  const records = [makeRecord({ startedAt: today, settledAt: today, prompt: "today's task" })];

  const csvResult = buildExportContent(records, { format: "csv", all: false });
  assert.match(csvResult.name, /^tasks-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(csvResult.content, /today's task/);
  assert.equal(csvResult.rowCount, 1);

  const jsonResult = buildExportContent(records, { format: "json", all: true });
  assert.equal(jsonResult.name, "tasks-all.json");
  const parsed = JSON.parse(jsonResult.content) as unknown[];
  assert.equal(parsed.length, 1);
  assert.equal(jsonResult.rowCount, 1);
});

test("buildExportContent filters to today's local day unless all is set", () => {
  const records = [makeRecord({ startedAt: "2020-01-01T00:00:00.000Z", settledAt: "2020-01-01T00:00:05.000Z" })];

  const todayResult = buildExportContent(records, { format: "csv", all: false });
  assert.equal(todayResult.rowCount, 0);

  const allResult = buildExportContent(records, { format: "csv", all: true });
  assert.equal(allResult.rowCount, 1);
});
