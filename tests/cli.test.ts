import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlWorkLog } from "kankaku/hub";
import { emptyUsage, WORK_RECORD_SCHEMA } from "kankaku/domain";
import type { WorkRecord } from "kankaku/domain";
import { runCli, type CliDeps } from "../src/cli-core.ts";
import { resolvePaths } from "../src/paths.ts";
import { writeState } from "../src/session-state.ts";

function tmpDeps(overrides: Partial<CliDeps> = {}): { dir: string; deps: CliDeps } {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-cli-"));
  return {
    dir,
    deps: {
      env: { KANKAKU_DIR: dir },
      cwd: dir,
      now: () => Date.now(),
      isAlive: () => true,
      pluginRoot: process.cwd(),
      ...overrides,
    },
  };
}

function sampleRecord(startedAt: Date): WorkRecord {
  return {
    schema: WORK_RECORD_SCHEMA,
    id: "id-1",
    prompt: "fix the report formatting",
    startedAt: startedAt.toISOString(),
    settledAt: new Date(startedAt.getTime() + 1000).toISOString(),
    wallMs: 1000,
    waitingMs: 0,
    workMs: 1000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { ...emptyUsage(), cost: 0.1 },
    status: "completed",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/repo",
  };
}

test("runCli report prints formatReport output built from the worklog", () => {
  const { dir, deps } = tmpDeps();
  try {
    const now = new Date();
    new JsonlWorkLog(dir).append(sampleRecord(now));
    const result = runCli(["report"], { ...deps, now: () => now.getTime() });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("fix the report formatting"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli report honors --days", () => {
  const { dir, deps } = tmpDeps();
  try {
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    new JsonlWorkLog(dir).append(sampleRecord(tenDaysAgo));
    const result = runCli(["report", "--days", "30"], { ...deps, now: () => now.getTime() });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("fix the report formatting"));

    const resultDefault = runCli(["report"], { ...deps, now: () => now.getTime() });
    assert.equal(resultDefault.stdout, "No tasks recorded in the last 7 days.\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli report says so when the worklog is empty", () => {
  const { dir, deps } = tmpDeps();
  try {
    const result = runCli(["report"], deps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "No tasks recorded in the last 7 days.\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli status reports no active sessions when the claude directory is empty", () => {
  const { dir, deps } = tmpDeps();
  try {
    const result = runCli(["status"], deps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "No active sessions.\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli status lists each session's id, pid liveness, open prompt and last cost", () => {
  const { dir, deps } = tmpDeps({ isAlive: (pid) => pid === 111 });
  try {
    const paths = resolvePaths({ env: deps.env, cwd: deps.cwd, sessionId: "s1" });
    writeState(paths.stateFile, {
      pid: 111,
      parentPid: 1,
      cwd: deps.cwd,
      startedAt: 1000,
      promptOpen: { id: "p1", startedAt: 1000, costAtStart: 0 },
      cost: { totalUsd: 2.5, updatedAt: 1000 },
      permissionOpen: null,
    });
    const paths2 = resolvePaths({ env: deps.env, cwd: deps.cwd, sessionId: "s2" });
    writeState(paths2.stateFile, {
      pid: 222,
      parentPid: 1,
      cwd: deps.cwd,
      startedAt: 1000,
      promptOpen: null,
      cost: null,
      permissionOpen: null,
    });

    const result = runCli(["status"], deps);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("s1"));
    assert.ok(result.stdout.includes("alive"));
    assert.ok(result.stdout.includes("$2.50"));
    assert.ok(result.stdout.includes("s2"));
    assert.ok(result.stdout.includes("dead"));
    assert.ok(result.stdout.includes("idle"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli setup prints the statusLine snippet with an absolute, existing statusline.ts path", () => {
  const { dir, deps } = tmpDeps();
  try {
    const result = runCli(["setup"], deps);
    assert.equal(result.exitCode, 0);
    const match = result.stdout.match(/([^\s"\\]+\/src\/statusline\.ts)/);
    assert.ok(match, "expected the snippet to contain a path ending in /src/statusline.ts");
    const path = match![1]!;
    assert.ok(path.endsWith("/src/statusline.ts"));
    assert.equal(existsSync(path), true);
    assert.ok(result.stdout.includes("statusLine"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli returns usage on stderr and exit code 1 for an unknown command", () => {
  const { dir, deps } = tmpDeps();
  try {
    const result = runCli(["bogus"], deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr && result.stderr.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
