import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatusline } from "../src/statusline-core.ts";
import { readState, writeState, mergeCost, type SessionState } from "../src/session-state.ts";
import { resolvePaths } from "../src/paths.ts";

function tmpEnv(): { dir: string; env: NodeJS.ProcessEnv; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-statusline-"));
  return { dir, env: { KANKAKU_DIR: dir }, cwd: "/repo" };
}

function baseState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    pid: 111,
    parentPid: 222,
    cwd: "/repo",
    startedAt: 1000,
    promptOpen: null,
    cost: null,
    permissionOpen: null,
    ...overrides,
  };
}

test("renderStatusline merges a finite cost into the session state file, creating it when absent", () => {
  const { dir, env, cwd } = tmpEnv();
  try {
    const input = {
      session_id: "s1",
      cwd,
      model: { id: "claude-opus-4" },
      cost: { total_cost_usd: 1.2345 },
    };
    const line = renderStatusline(input, { env, now: () => 5000, readState, mergeCost });
    assert.equal(line, "kankaku idle · $1.23");

    const paths = resolvePaths({ env, cwd, sessionId: "s1" });
    const state = readState(paths.stateFile);
    assert.deepEqual(state?.cost, { totalUsd: 1.2345, updatedAt: 5000, model: "claude-opus-4" });
    assert.equal(state?.pid, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStatusline updates only the cost field of an existing state file", () => {
  const { dir, env, cwd } = tmpEnv();
  try {
    const paths = resolvePaths({ env, cwd, sessionId: "s1" });
    writeState(paths.stateFile, baseState({ promptOpen: { id: "p1", startedAt: 1000, costAtStart: 0 } }));

    const input = { session_id: "s1", cwd, cost: { total_cost_usd: 0.5 } };
    renderStatusline(input, { env, now: () => 61000, readState, mergeCost });

    const state = readState(paths.stateFile);
    assert.equal(state?.cost?.totalUsd, 0.5);
    assert.equal(state?.pid, 111);
    assert.deepEqual(state?.promptOpen, { id: "p1", startedAt: 1000, costAtStart: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStatusline formats the open prompt's elapsed clock as m:ss under an hour", () => {
  const { dir, env, cwd } = tmpEnv();
  try {
    const paths = resolvePaths({ env, cwd, sessionId: "s1" });
    writeState(paths.stateFile, baseState({ promptOpen: { id: "p1", startedAt: 0, costAtStart: 0 } }));

    const input = { session_id: "s1", cwd };
    const line = renderStatusline(input, { env, now: () => 65_000, readState, mergeCost });
    assert.equal(line, "kankaku 1:05");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStatusline formats the open prompt's elapsed clock as h:mm:ss past an hour", () => {
  const { dir, env, cwd } = tmpEnv();
  try {
    const paths = resolvePaths({ env, cwd, sessionId: "s1" });
    writeState(paths.stateFile, baseState({ promptOpen: { id: "p1", startedAt: 0, costAtStart: 0 } }));

    const input = { session_id: "s1", cwd };
    const oneHourFiveMinSevenSec = (3600 + 5 * 60 + 7) * 1000;
    const line = renderStatusline(input, { env, now: () => oneHourFiveMinSevenSec, readState, mergeCost });
    assert.equal(line, "kankaku 1:05:07");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStatusline reports idle when no prompt is open", () => {
  const { dir, env, cwd } = tmpEnv();
  try {
    const paths = resolvePaths({ env, cwd, sessionId: "s1" });
    writeState(paths.stateFile, baseState());

    const input = { session_id: "s1", cwd };
    const line = renderStatusline(input, { env, now: () => 5000, readState, mergeCost });
    assert.equal(line, "kankaku idle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStatusline prints just the clock, with no cost suffix, when cost.total_cost_usd is absent", () => {
  const { dir, env, cwd } = tmpEnv();
  try {
    let mergeCalled = false;
    const spyMergeCost: typeof mergeCost = (...args) => {
      mergeCalled = true;
      return mergeCost(...args);
    };
    const paths = resolvePaths({ env, cwd, sessionId: "s1" });
    writeState(paths.stateFile, baseState({ promptOpen: { id: "p1", startedAt: 0, costAtStart: 0 } }));

    const input = { session_id: "s1", cwd };
    const line = renderStatusline(input, { env, now: () => 5000, readState, mergeCost: spyMergeCost });
    assert.equal(line, "kankaku 0:05");
    assert.equal(mergeCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStatusline ignores a non-finite cost.total_cost_usd", () => {
  const { dir, env, cwd } = tmpEnv();
  try {
    const input = { session_id: "s1", cwd, cost: { total_cost_usd: "not-a-number" } };
    const line = renderStatusline(input, { env, now: () => 5000, readState, mergeCost });
    assert.equal(line, "kankaku idle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStatusline returns bare 'kankaku' on malformed input", () => {
  assert.equal(
    renderStatusline(null, { env: {}, now: () => 0, readState, mergeCost }),
    "kankaku",
  );
  assert.equal(
    renderStatusline("not an object", { env: {}, now: () => 0, readState, mergeCost }),
    "kankaku",
  );
  assert.equal(
    renderStatusline({}, { env: {}, now: () => 0, readState, mergeCost }),
    "kankaku",
  );
});

test("renderStatusline returns bare 'kankaku' when a dependency throws", () => {
  const throwingReadState: typeof readState = () => {
    throw new Error("boom");
  };
  const line = renderStatusline(
    { session_id: "s1", cwd: "/repo" },
    { env: {}, now: () => 0, readState: throwingReadState, mergeCost },
  );
  assert.equal(line, "kankaku");
});

test("renderStatusline output never contains a newline", () => {
  const { dir, env, cwd } = tmpEnv();
  try {
    const input = { session_id: "s1", cwd, cost: { total_cost_usd: 1 } };
    const line = renderStatusline(input, { env, now: () => 5000, readState, mergeCost });
    assert.equal(line.includes("\n"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStatusline resolves cwd from workspace.current_dir when present, falling back to cwd", () => {
  const { dir, env } = tmpEnv();
  try {
    const input = {
      session_id: "s1",
      cwd: "/ignored",
      workspace: { current_dir: "/repo" },
      cost: { total_cost_usd: 1 },
    };
    renderStatusline(input, { env, now: () => 5000, readState, mergeCost });
    const paths = resolvePaths({ env, cwd: "/repo", sessionId: "s1" });
    assert.notEqual(readState(paths.stateFile), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
