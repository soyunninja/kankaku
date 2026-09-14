import assert from "node:assert/strict";
import { test } from "node:test";
import { exportRows, toCsv, toJson } from "../src/domain/export.ts";
import { buildTasks } from "../src/domain/task-view.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    project: "/abs/project/path",
    sessionId: "session-1",
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
    usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0.5 },
    status: "completed",
    model: "anthropic/claude-opus",
    client: "acme",
    sessionName: "billing sprint",
    ...overrides,
  };
}

test("exportRows produces one flat row per task with the documented fields", () => {
  const parent = makeRecord({ id: "p1", segments: { review: 1200 } });
  const child = makeRecord({ id: "c1", role: "subagent", pid: 200, parentPid: 100, startedAt: "2026-09-10T16:01:00.000Z", settledAt: "2026-09-10T16:02:00.000Z" });

  const tasks = buildTasks([parent, child]);
  const rows = exportRows(tasks);

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.id, "p1");
  assert.equal(row.day, "2026-09-10");
  assert.equal(row.startedAt, "2026-09-10T16:00:00.000Z");
  assert.equal(row.endedAt, tasks[0]!.endedAt);
  assert.equal(row.client, "acme");
  assert.equal(row.sessionName, "billing sprint");
  assert.equal(row.sessionId, "session-1");
  assert.equal(row.project, "/abs/project/path");
  assert.equal(row.status, "completed");
  assert.equal(row.prompt, "hello");
  assert.equal(row.wallMs, tasks[0]!.wallMs);
  assert.equal(row.waitingMs, tasks[0]!.waitingMs);
  assert.equal(row.workMs, tasks[0]!.workMs);
  assert.equal(row.cost, tasks[0]!.usage.cost);
  assert.equal(row.tokensIn, tasks[0]!.usage.input);
  assert.equal(row.tokensOut, tasks[0]!.usage.output);
  assert.equal(row.cacheRead, tasks[0]!.usage.cacheRead);
  assert.equal(row.subagentCount, 1);
  assert.equal(row.segments, JSON.stringify(tasks[0]!.segments));
  assert.equal(row.model, "anthropic/claude-opus");
});

test("exportRows truncates the prompt to 200 chars and collapses newlines", () => {
  const longPrompt = `line one\nline two\r\nline three${"x".repeat(250)}`;
  const parent = makeRecord({ id: "p1", prompt: longPrompt });

  const rows = exportRows(buildTasks([parent]));

  assert.ok(rows[0]!.prompt.length <= 200);
  assert.equal(rows[0]!.prompt.includes("\n"), false);
  assert.equal(rows[0]!.prompt.includes("\r"), false);
});

test("exportRows defaults client, sessionName, sessionId and model to empty strings when absent", () => {
  const parent = makeRecord({ id: "p1", client: undefined, sessionName: undefined, sessionId: undefined, model: undefined });

  const rows = exportRows(buildTasks([parent]));

  assert.equal(rows[0]!.client, "");
  assert.equal(rows[0]!.sessionName, "");
  assert.equal(rows[0]!.sessionId, "");
  assert.equal(rows[0]!.model, "");
});

test("toCsv renders a header row plus one quoted row per record (RFC 4180)", () => {
  const parent = makeRecord({ id: "p1", prompt: 'has, comma and "quote"\nand newline' });
  const rows = exportRows(buildTasks([parent]));

  const csv = toCsv(rows);
  const lines = csv.split("\n");

  assert.equal(lines[0], Object.keys(rows[0]!).join(","));
  assert.match(csv, /"has, comma and ""quote""/);
  // the row's own newline was collapsed by exportRows, so it must not add a stray CSV line
  assert.equal(lines.length, 2);
});

test("toCsv renders only the header for an empty list", () => {
  const csv = toCsv([]);
  const lines = csv.split("\n");

  assert.equal(lines.length, 1);
  assert.equal(lines[0], "id,day,startedAt,endedAt,client,sessionName,sessionId,project,status,prompt,wallMs,waitingMs,workMs,cost,tokensIn,tokensOut,cacheRead,subagentCount,segments,model");
});

test("toJson renders pretty-printed JSON matching the rows", () => {
  const parent = makeRecord({ id: "p1" });
  const rows = exportRows(buildTasks([parent]));

  const json = toJson(rows);

  assert.deepEqual(JSON.parse(json), rows);
  assert.match(json, /\n {4}"id": "p1"/); // pretty-printed: 2-space indent per nesting level (array > object)
});
