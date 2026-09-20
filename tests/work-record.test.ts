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

test("isWorkRecord rejects a record with a negative wallMs, waitingMs or workMs", () => {
  assert.equal(isWorkRecord(makeRecord({ wallMs: -1 })), false);
  assert.equal(isWorkRecord(makeRecord({ waitingMs: -1 })), false);
  assert.equal(isWorkRecord(makeRecord({ workMs: -1 })), false);
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

test("isWorkRecord accepts a record with a string sessionDir, and one without one", () => {
  assert.equal(isWorkRecord(makeRecord({ sessionDir: "/custom/session/dir" })), true);
  assert.equal(isWorkRecord(makeRecord()), true);
});

test("isWorkRecord rejects a record with a non-string sessionDir", () => {
  assert.equal(isWorkRecord({ ...makeRecord(), sessionDir: 42 }), false);
});

test("isWorkRecord accepts a record with string hub metadata fields", () => {
  const record = makeRecord({
    clientId: "c-acme",
    clientName: "Acme",
    projectId: "p-portal",
    projectName: "Portal",
    machine: "laptop",
  });
  assert.equal(isWorkRecord(record), true);
});

test("isWorkRecord accepts a record without any hub metadata fields", () => {
  assert.equal(isWorkRecord(makeRecord()), true);
});

test("isWorkRecord rejects a record with a non-string hub metadata field", () => {
  assert.equal(isWorkRecord({ ...makeRecord(), clientId: 42 }), false);
  assert.equal(isWorkRecord({ ...makeRecord(), clientName: 42 }), false);
  assert.equal(isWorkRecord({ ...makeRecord(), projectId: 42 }), false);
  assert.equal(isWorkRecord({ ...makeRecord(), projectName: 42 }), false);
  assert.equal(isWorkRecord({ ...makeRecord(), machine: 42 }), false);
});

test("isWorkRecord accepts a record without roleConfidence or orchestratorRef (SUBAGENT-REQ-016: an older record stays valid)", () => {
  assert.equal(isWorkRecord(makeRecord()), true);
});

test("isWorkRecord accepts an orchestrator record with roleConfidence 'uncertain'", () => {
  const record = makeRecord({ roleConfidence: "uncertain" });
  assert.equal(isWorkRecord(record), true);
});

test("isWorkRecord rejects a roleConfidence value other than 'uncertain'", () => {
  assert.equal(isWorkRecord({ ...makeRecord(), roleConfidence: "confirmed" }), false);
  assert.equal(isWorkRecord({ ...makeRecord(), roleConfidence: 1 }), false);
});

test("isWorkRecord accepts a subagent record with a well-formed orchestratorRef", () => {
  const record = makeRecord({
    role: "subagent",
    orchestratorRef: { pid: 42, project: "/other/worktree", startedAt: "2026-09-10T16:00:00.000Z" },
  });
  assert.equal(isWorkRecord(record), true);
});

test("isWorkRecord rejects a malformed orchestratorRef", () => {
  assert.equal(isWorkRecord({ ...makeRecord(), orchestratorRef: { pid: "42", project: "/x", startedAt: "t" } }), false);
  assert.equal(isWorkRecord({ ...makeRecord(), orchestratorRef: { pid: 42 } }), false);
  assert.equal(isWorkRecord({ ...makeRecord(), orchestratorRef: "not-an-object" }), false);
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
