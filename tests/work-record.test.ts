import assert from "node:assert/strict";
import { test } from "node:test";
import { finiteOrZero, isWorkRecord } from "../src/domain/work-record.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec-1",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/tmp/project",
    prompt: "hello",
    startedAt: "2026-09-10T16:00:00.000Z",
    settledAt: "2026-09-10T16:00:01.000Z",
    wallMs: 1000,
    waitingMs: 0,
    workMs: 1000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    status: "completed",
    ...overrides,
  };
}

test("isWorkRecord accepts a well-formed record", () => {
  assert.equal(isWorkRecord(makeRecord()), true);
});

test("isWorkRecord rejects a non-object value", () => {
  assert.equal(isWorkRecord(null), false);
  assert.equal(isWorkRecord(undefined), false);
  assert.equal(isWorkRecord("record"), false);
  assert.equal(isWorkRecord(42), false);
});

test("isWorkRecord rejects a record with a missing required field", () => {
  const record = makeRecord() as unknown as Record<string, unknown>;
  delete record["usage"];
  assert.equal(isWorkRecord(record), false);
});

test("isWorkRecord rejects a record with a non-finite duration field", () => {
  const record = makeRecord({ wallMs: Number.NaN });
  assert.equal(isWorkRecord(record), false);
});

test("isWorkRecord rejects a record with an invalid role or status", () => {
  assert.equal(isWorkRecord(makeRecord({ role: "manager" as never })), false);
  assert.equal(isWorkRecord(makeRecord({ status: "unknown" as never })), false);
});

test("isWorkRecord rejects a record whose subagents is not an array", () => {
  const record = makeRecord() as unknown as Record<string, unknown>;
  record["subagents"] = {};
  assert.equal(isWorkRecord(record), false);
});

test("isWorkRecord accepts a record without client or sessionName", () => {
  const record = makeRecord();
  assert.equal(isWorkRecord(record), true);
});

test("isWorkRecord accepts a record with string client and sessionName", () => {
  const record = makeRecord({ client: "acme", sessionName: "my session" });
  assert.equal(isWorkRecord(record), true);
});

test("isWorkRecord rejects a record with a non-string client or sessionName", () => {
  assert.equal(isWorkRecord({ ...makeRecord(), client: 42 }), false);
  assert.equal(isWorkRecord({ ...makeRecord(), sessionName: 42 }), false);
});

test("finiteOrZero returns the number for finite values", () => {
  assert.equal(finiteOrZero(5), 5);
  assert.equal(finiteOrZero(0), 0);
  assert.equal(finiteOrZero(-3.5), -3.5);
});

test("finiteOrZero returns 0 for undefined, NaN, Infinity and non-numbers", () => {
  assert.equal(finiteOrZero(undefined), 0);
  assert.equal(finiteOrZero(Number.NaN), 0);
  assert.equal(finiteOrZero(Number.POSITIVE_INFINITY), 0);
  assert.equal(finiteOrZero("5" as unknown as number), 0);
});
