import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlWorkLog } from "kankaku-pi/hub";
import { emptyUsage, WORK_RECORD_SCHEMA } from "kankaku-pi/domain";
import type { WorkRecord } from "kankaku-pi/domain";
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

function statusFixture(opts: { promptOpen: boolean; total: number | undefined; recorded: number[]; baseline?: number; costAtStart?: number }) {
  const t = tmpDeps({ isAlive: () => true });
  const paths = resolvePaths({ env: t.deps.env, cwd: t.deps.cwd, sessionId: "s1" });
  writeState(paths.stateFile, {
    pid: 111,
    parentPid: 1,
    cwd: t.deps.cwd,
    startedAt: 1000,
    promptOpen: opts.promptOpen ? { id: "p1", startedAt: 1000, costAtStart: opts.costAtStart ?? 0 } : null,
    permissionOpen: null,
    ...(opts.baseline !== undefined ? { costBaseline: opts.baseline } : {}),
  });
  if (opts.total !== undefined) writeCost(t.deps.env, "s1", { totalUsd: opts.total, updatedAt: 1000 });
  const log = new JsonlWorkLog(t.dir);
  opts.recorded.forEach((cost, i) => {
    const base = sampleRecord(new Date(1_000_000 + i));
    log.append({ ...base, id: `r${i}`, sessionId: "s1", usage: { ...base.usage, cost } });
  });
  // Another session's record must never count.
  const other = sampleRecord(new Date(2_000_000));
  log.append({ ...other, id: "other", sessionId: "s2", usage: { ...other.usage, cost: 99 } });
  return t;
}

test("runCli status shows recorded vs total, with no warning when they match", async () => {
  const t = statusFixture({ promptOpen: false, total: 3, recorded: [1, 2] });
  try {
    const out = (await runCli(["status"], t.deps)).stdout;
    assert.ok(out.includes("recorded $3.00 of $3.00"), out);
    assert.equal(out.includes("pending"), false);
    assert.equal(out.includes("never recorded"), false);
  } finally {
    cleanup(t);
  }
});

test("runCli status: idle with a baseline, the spend since the last settle is pending for the next prompt", async () => {
  const t = statusFixture({ promptOpen: false, total: 7, recorded: [1, 2], baseline: 3 });
  try {
    const out = (await runCli(["status"], t.deps)).stdout;
    assert.ok(out.includes("recorded $3.00 of $7.00 (pending $4.00, goes to the next prompt)"), out);
    assert.equal(out.includes("never recorded"), false);
  } finally {
    cleanup(t);
  }
});

test("runCli status: idle with NO baseline, a gap is never recorded and nothing is promised to the next prompt", async () => {
  // A session upgraded mid-way, or resumed without state: the next prompt
  // starts at the snapshot, so it will NOT pick this gap up.
  const t = statusFixture({ promptOpen: false, total: 7, recorded: [1, 2] });
  try {
    const out = (await runCli(["status"], t.deps)).stdout;
    assert.ok(out.includes("recorded $3.00 of $7.00 (never recorded $4.00)"), out);
    assert.equal(out.includes("goes to the next prompt"), false);
  } finally {
    cleanup(t);
  }
});

test("runCli status: idle with a baseline above what was recorded shows both the pending and the never-recorded parts", async () => {
  const t = statusFixture({ promptOpen: false, total: 7, recorded: [1, 2], baseline: 6 });
  try {
    const out = (await runCli(["status"], t.deps)).stdout;
    assert.ok(out.includes("recorded $3.00 of $7.00 (pending $1.00, goes to the next prompt) (never recorded $3.00)"), out);
  } finally {
    cleanup(t);
  }
});

test("runCli status: with a prompt open, its running spend is neither pending nor never recorded", async () => {
  const t = statusFixture({ promptOpen: true, total: 7, recorded: [1, 2], costAtStart: 6.5 });
  try {
    const out = (await runCli(["status"], t.deps)).stdout;
    assert.ok(out.includes("recorded $3.00 of $7.00 (this prompt so far $0.50) (never recorded $3.50)"), out);
    assert.equal(out.includes("goes to the next prompt"), false);
  } finally {
    cleanup(t);
  }
});

test("runCli status: with a prompt open that accounts for the whole gap, nothing else is reported", async () => {
  const t = statusFixture({ promptOpen: true, total: 7, recorded: [1, 2], costAtStart: 3 });
  try {
    const out = (await runCli(["status"], t.deps)).stdout;
    assert.ok(out.includes("recorded $3.00 of $7.00 (this prompt so far $4.00)"), out);
    assert.equal(out.includes("never recorded"), false);
    assert.equal(out.includes("pending"), false);
  } finally {
    cleanup(t);
  }
});

test("runCli status ignores a gap of one cent or less", async () => {
  const t = statusFixture({ promptOpen: false, total: 3.01, recorded: [1, 2], baseline: 3 });
  try {
    const out = (await runCli(["status"], t.deps)).stdout;
    assert.equal(out.includes("pending"), false);
    assert.equal(out.includes("never recorded"), false);
  } finally {
    cleanup(t);
  }
});

test("runCli status omits the recorded part when no total is known, and keeps the existing parts", async () => {
  const t = statusFixture({ promptOpen: false, total: undefined, recorded: [1] });
  try {
    const out = (await runCli(["status"], t.deps)).stdout;
    assert.equal(out.includes("recorded"), false);
    assert.ok(out.includes("s1  pid 111 (alive)  idle  cost -"), out);
  } finally {
    cleanup(t);
  }
});
