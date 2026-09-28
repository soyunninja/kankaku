import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverStaleSessions } from "../src/inflight-recovery.ts";
import { writeState, type SessionState } from "../src/session-state.ts";
import { appendEvent } from "../src/event-log.ts";
import { writeCost, costFile } from "../src/cost-store.ts";

function baseState(overrides: Partial<SessionState>): SessionState {
  return {
    pid: 1,
    parentPid: 2,
    cwd: "/repo",
    startedAt: 1000,
    promptOpen: null,
    permissionOpen: null,
    ...overrides,
  };
}

function setup(): { claudeDir: string; homeDir: string; env: { HOME: string } } {
  const claudeDir = mkdtempSync(join(tmpdir(), "kankaku-claude-recovery-"));
  const homeDir = mkdtempSync(join(tmpdir(), "kankaku-claude-recovery-home-"));
  return { claudeDir, homeDir, env: { HOME: homeDir } };
}

function teardown(dirs: { claudeDir: string; homeDir: string }): void {
  rmSync(dirs.claudeDir, { recursive: true, force: true });
  rmSync(dirs.homeDir, { recursive: true, force: true });
}

test("recoverStaleSessions replays an open prompt from a dead session as interrupted and deletes its files", () => {
  const dirs = setup();
  try {
    const stateFile = join(dirs.claudeDir, "dead-open.state.json");
    const eventsFile = join(dirs.claudeDir, "dead-open.events.jsonl");
    writeState(stateFile, baseState({ pid: 9999, promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined } }));
    appendEvent(eventsFile, { ts: 1000, event: "UserPromptSubmit", prompt: "cut off" });
    appendEvent(eventsFile, { ts: 1500, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} });
    writeCost(dirs.env, "dead-open", { totalUsd: 1, updatedAt: 1000, model: "claude-x" });

    const records = recoverStaleSessions({
      claudeDir: dirs.claudeDir,
      currentSessionId: "current",
      isAlive: () => false,
      now: 5000,
      env: dirs.env,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "interrupted");
    assert.equal(records[0]?.sessionId, "dead-open");
    assert.equal(records[0]?.project, "/repo");
    assert.equal(records[0]?.model, "anthropic/claude-x");
    assert.equal(existsSync(stateFile), false);
    assert.equal(existsSync(eventsFile), false);
    assert.equal(existsSync(costFile(dirs.env, "dead-open")), false);
  } finally {
    teardown(dirs);
  }
});

test("recoverStaleSessions deletes a dead session's files even when nothing was open", () => {
  const dirs = setup();
  try {
    const stateFile = join(dirs.claudeDir, "dead-idle.state.json");
    writeState(stateFile, baseState({ pid: 9998, promptOpen: null }));

    const records = recoverStaleSessions({
      claudeDir: dirs.claudeDir,
      currentSessionId: "current",
      isAlive: () => false,
      now: 5000,
      env: dirs.env,
    });

    assert.equal(records.length, 0);
    assert.equal(existsSync(stateFile), false);
  } finally {
    teardown(dirs);
  }
});

test("recoverStaleSessions leaves a live session's files untouched", () => {
  const dirs = setup();
  try {
    const stateFile = join(dirs.claudeDir, "alive.state.json");
    writeState(stateFile, baseState({ pid: 1234, promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined } }));

    const records = recoverStaleSessions({
      claudeDir: dirs.claudeDir,
      currentSessionId: "current",
      isAlive: (pid) => pid === 1234,
      now: 5000,
      env: dirs.env,
    });

    assert.equal(records.length, 0);
    assert.equal(existsSync(stateFile), true);
  } finally {
    teardown(dirs);
  }
});

test("recoverStaleSessions skips the current session's own state file", () => {
  const dirs = setup();
  try {
    const stateFile = join(dirs.claudeDir, "current.state.json");
    writeState(stateFile, baseState({ pid: 9999, promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined } }));

    const records = recoverStaleSessions({
      claudeDir: dirs.claudeDir,
      currentSessionId: "current",
      isAlive: () => false,
      now: 5000,
      env: dirs.env,
    });

    assert.equal(records.length, 0);
    assert.equal(existsSync(stateFile), true);
  } finally {
    teardown(dirs);
  }
});

test("recoverStaleSessions treats pid <= 0 as dead even when isAlive says otherwise (T7 placeholder-state defect), and deletes with no open prompt to replay when cwd is empty", () => {
  const dirs = setup();
  try {
    const stateFile = join(dirs.claudeDir, "placeholder.state.json");
    writeState(
      stateFile,
      baseState({
        pid: 0,
        cwd: "",
        promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined },
      }),
    );

    const records = recoverStaleSessions({
      claudeDir: dirs.claudeDir,
      currentSessionId: "current",
      isAlive: () => true, // exactly the old process.kill(0, 0) bug: reports alive
      now: 5000,
      env: dirs.env,
    });

    assert.equal(records.length, 0); // no cwd to attribute a replayed record to: deleted, not replayed
    assert.equal(existsSync(stateFile), false);
  } finally {
    teardown(dirs);
  }
});

test("recoverStaleSessions replays a pid <= 0 session's open prompt when cwd is non-empty", () => {
  const dirs = setup();
  try {
    const stateFile = join(dirs.claudeDir, "zero-pid-open.state.json");
    const eventsFile = join(dirs.claudeDir, "zero-pid-open.events.jsonl");
    writeState(stateFile, baseState({ pid: -1, cwd: "/repo", promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined } }));
    appendEvent(eventsFile, { ts: 1000, event: "UserPromptSubmit", prompt: "cut off" });

    const records = recoverStaleSessions({
      claudeDir: dirs.claudeDir,
      currentSessionId: "current",
      isAlive: () => true,
      now: 5000,
      env: dirs.env,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "interrupted");
    assert.equal(existsSync(stateFile), false);
  } finally {
    teardown(dirs);
  }
});
