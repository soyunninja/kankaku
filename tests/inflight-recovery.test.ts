import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverStaleSessions } from "../src/inflight-recovery.ts";
import { writeState, type SessionState } from "../src/session-state.ts";
import { appendEvent } from "../src/event-log.ts";

function baseState(overrides: Partial<SessionState>): SessionState {
  return {
    pid: 1,
    parentPid: 2,
    cwd: "/repo",
    startedAt: 1000,
    promptOpen: null,
    cost: null,
    permissionOpen: null,
    ...overrides,
  };
}

function setup() {
  const claudeDir = mkdtempSync(join(tmpdir(), "kankaku-claude-recovery-"));
  return claudeDir;
}

test("recoverStaleSessions replays an open prompt from a dead session as interrupted and deletes its files", () => {
  const claudeDir = setup();
  try {
    const stateFile = join(claudeDir, "dead-open.state.json");
    const eventsFile = join(claudeDir, "dead-open.events.jsonl");
    writeState(stateFile, baseState({ pid: 9999, promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined } }));
    appendEvent(eventsFile, { ts: 1000, event: "UserPromptSubmit", prompt: "cut off" });
    appendEvent(eventsFile, { ts: 1500, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} });

    const records = recoverStaleSessions({
      claudeDir,
      currentSessionId: "current",
      isAlive: () => false,
      now: 5000,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "interrupted");
    assert.equal(records[0]?.sessionId, "dead-open");
    assert.equal(records[0]?.project, "/repo");
    assert.equal(existsSync(stateFile), false);
    assert.equal(existsSync(eventsFile), false);
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("recoverStaleSessions deletes a dead session's files even when nothing was open", () => {
  const claudeDir = setup();
  try {
    const stateFile = join(claudeDir, "dead-idle.state.json");
    writeState(stateFile, baseState({ pid: 9998, promptOpen: null }));

    const records = recoverStaleSessions({
      claudeDir,
      currentSessionId: "current",
      isAlive: () => false,
      now: 5000,
    });

    assert.equal(records.length, 0);
    assert.equal(existsSync(stateFile), false);
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("recoverStaleSessions leaves a live session's files untouched", () => {
  const claudeDir = setup();
  try {
    const stateFile = join(claudeDir, "alive.state.json");
    writeState(stateFile, baseState({ pid: 1234, promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined } }));

    const records = recoverStaleSessions({
      claudeDir,
      currentSessionId: "current",
      isAlive: (pid) => pid === 1234,
      now: 5000,
    });

    assert.equal(records.length, 0);
    assert.equal(existsSync(stateFile), true);
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("recoverStaleSessions skips the current session's own state file", () => {
  const claudeDir = setup();
  try {
    const stateFile = join(claudeDir, "current.state.json");
    writeState(stateFile, baseState({ pid: 9999, promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined } }));

    const records = recoverStaleSessions({
      claudeDir,
      currentSessionId: "current",
      isAlive: () => false,
      now: 5000,
    });

    assert.equal(records.length, 0);
    assert.equal(existsSync(stateFile), true);
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});
