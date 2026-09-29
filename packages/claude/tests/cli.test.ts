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
import { writeCost } from "../src/cost-store.ts";

function tmpDeps(overrides: Partial<CliDeps> = {}): { dir: string; homeDir: string; deps: CliDeps } {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-cli-"));
  const homeDir = mkdtempSync(join(tmpdir(), "kankaku-claude-cli-home-"));
  return {
    dir,
    homeDir,
    deps: {
      env: { KANKAKU_DIR: dir, HOME: homeDir },
      cwd: dir,
      now: () => Date.now(),
      isAlive: () => true,
      pluginRoot: process.cwd(),
      ...overrides,
    },
  };
}

function cleanup(t: { dir: string; homeDir: string }): void {
  rmSync(t.dir, { recursive: true, force: true });
  rmSync(t.homeDir, { recursive: true, force: true });
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

test("runCli report prints formatReport output built from the worklog", async () => {
  const { dir, homeDir, deps } = tmpDeps();
  try {
    const now = new Date();
    new JsonlWorkLog(dir).append(sampleRecord(now));
    const result = await runCli(["report"], { ...deps, now: () => now.getTime() });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("fix the report formatting"));
  } finally {
    cleanup({ dir, homeDir });
  }
});

test("runCli report honors --days", async () => {
  const { dir, homeDir, deps } = tmpDeps();
  try {
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    new JsonlWorkLog(dir).append(sampleRecord(tenDaysAgo));
    const result = await runCli(["report", "--days", "30"], { ...deps, now: () => now.getTime() });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("fix the report formatting"));

    const resultDefault = await runCli(["report"], { ...deps, now: () => now.getTime() });
    assert.equal(resultDefault.stdout, "No tasks recorded in the last 7 days.\n");
  } finally {
    cleanup({ dir, homeDir });
  }
});

test("runCli report says so when the worklog is empty", async () => {
  const { dir, homeDir, deps } = tmpDeps();
  try {
    const result = await runCli(["report"], deps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "No tasks recorded in the last 7 days.\n");
  } finally {
    cleanup({ dir, homeDir });
  }
});

test("runCli status reports no active sessions when the claude directory is empty", async () => {
  const { dir, homeDir, deps } = tmpDeps();
  try {
    const result = await runCli(["status"], deps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "target: none (no catalog cache)\ntask: none\nNo active sessions.\n");
  } finally {
    cleanup({ dir, homeDir });
  }
});

test("runCli status lists each session's id, pid liveness, open prompt and last cost", async () => {
  const { dir, homeDir, deps } = tmpDeps({ isAlive: (pid) => pid === 111 });
  try {
    const paths = resolvePaths({ env: deps.env, cwd: deps.cwd, sessionId: "s1" });
    writeState(paths.stateFile, {
      pid: 111,
      parentPid: 1,
      cwd: deps.cwd,
      startedAt: 1000,
      promptOpen: { id: "p1", startedAt: 1000, costAtStart: 0 },
      permissionOpen: null,
    });
    writeCost(deps.env, "s1", { totalUsd: 2.5, updatedAt: 1000 });
    const paths2 = resolvePaths({ env: deps.env, cwd: deps.cwd, sessionId: "s2" });
    writeState(paths2.stateFile, {
      pid: 222,
      parentPid: 1,
      cwd: deps.cwd,
      startedAt: 1000,
      promptOpen: null,
      permissionOpen: null,
    });

    const result = await runCli(["status"], deps);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("s1"));
    assert.ok(result.stdout.includes("alive"));
    assert.ok(result.stdout.includes("$2.50"));
    assert.ok(result.stdout.includes("s2"));
    assert.ok(result.stdout.includes("dead"));
    assert.ok(result.stdout.includes("idle"));
  } finally {
    cleanup({ dir, homeDir });
  }
});

test("runCli setup prints the statusLine snippet with an absolute, existing statusline.js path under dist/", async () => {
  const { dir, homeDir, deps } = tmpDeps();
  try {
    const result = await runCli(["setup"], deps);
    assert.equal(result.exitCode, 0);
    const match = result.stdout.match(/([^\s"\\]+\/dist\/statusline\.js)/);
    assert.ok(match, "expected the snippet to contain a path ending in /dist/statusline.js");
    const path = match![1]!;
    assert.ok(path.endsWith("/dist/statusline.js"));
    assert.equal(existsSync(path), true);
    assert.ok(result.stdout.includes("statusLine"));
  } finally {
    cleanup({ dir, homeDir });
  }
});

test("runCli dispatches sync status and rejects unknown sync arguments", async () => {
  const { dir, homeDir, deps } = tmpDeps();
  try {
    const status = await runCli(["sync", "status"], deps);
    assert.equal(status.exitCode, 0);
    assert.match(status.stdout, /unconfigured/);
    const invalid = await runCli(["sync", "unexpected"], deps);
    assert.equal(invalid.exitCode, 1);
    assert.match(invalid.stderr ?? "", /usage/i);
  } finally { cleanup({ dir, homeDir }); }
});

test("runCli dispatches doctor as a local diagnostic", async () => {
  const { dir, homeDir, deps } = tmpDeps();
  try {
    const result = await runCli(["doctor"], deps);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Hub \/ sync/);
    assert.match(result.stdout, /hub: unconfigured/);
  } finally { cleanup({ dir, homeDir }); }
});

test("runCli returns usage on stderr and exit code 1 for an unknown command", async () => {
  const { dir, homeDir, deps } = tmpDeps();
  try {
    const result = await runCli(["bogus"], deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr && result.stderr.length > 0);
  } finally {
    cleanup({ dir, homeDir });
  }
});
