import { test } from "node:test";
import assert from "node:assert/strict";
import { isWorkRecord, emptyUsage, WORK_RECORD_SCHEMA } from "kankaku/domain";
import type { WorkRecordCore } from "kankaku/domain";
import { buildClaudeRecord } from "../src/record.ts";
import type { SessionState } from "../src/session-state.ts";

function core(): WorkRecordCore {
  return {
    schema: WORK_RECORD_SCHEMA,
    id: "id-1",
    prompt: "hi",
    startedAt: new Date(1000).toISOString(),
    settledAt: new Date(2000).toISOString(),
    wallMs: 1000,
    waitingMs: 0,
    workMs: 1000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: emptyUsage(),
    status: "completed",
  };
}

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    pid: 111,
    parentPid: 222,
    cwd: "/repo",
    startedAt: 1000,
    promptOpen: null,
    permissionOpen: null,
    ...overrides,
  };
}

test("buildClaudeRecord attaches orchestrator metadata from the session state", () => {
  const record = buildClaudeRecord(core(), state(), "session-1", undefined);
  assert.equal(record.role, "orchestrator");
  assert.equal(record.pid, 111);
  assert.equal(record.parentPid, 222);
  assert.equal(record.project, "/repo");
  assert.equal(record.sessionId, "session-1");
  assert.equal(record.mode, "claude-code");
  assert.equal(isWorkRecord(record), true);
});

test("buildClaudeRecord sets model to anthropic/<id> only when a model was passed in explicitly", () => {
  const withModel = buildClaudeRecord(core(), state(), "session-1", "claude-opus-4");
  assert.equal(withModel.model, "anthropic/claude-opus-4");

  const withoutModel = buildClaudeRecord(core(), state(), "session-1", undefined);
  assert.equal(withoutModel.model, undefined);
});
