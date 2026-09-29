import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkRecord } from "kankaku-pi/domain";
import { handleHook, type HandleHookDeps } from "../src/handle-hook.ts";
import { writeCost } from "../src/cost-store.ts";
import { resolvePaths } from "../src/paths.ts";
import { readState, writeState } from "../src/session-state.ts";

interface Rig {
  kankakuDir: string;
  homeDir: string;
  deps: HandleHookDeps;
  t: { now: number };
}

function makeRig(): Rig {
  const kankakuDir = mkdtempSync(join(tmpdir(), "kankaku-claude-chain-"));
  const homeDir = mkdtempSync(join(tmpdir(), "kankaku-claude-chain-home-"));
  const t = { now: 0 };
  const deps: HandleHookDeps = {
    env: { KANKAKU_DIR: kankakuDir, HOME: homeDir },
    now: () => t.now,
    sleep: async (ms) => {
      t.now += ms;
    },
    isAlive: () => true,
    runPs: () => ({ ppid: 42, comm: "claude" }),
    stderr: () => {},
    autoSync: async () => {},
  };
  return { kankakuDir, homeDir, deps, t };
}

function cleanup(rig: Rig): void {
  rmSync(rig.kankakuDir, { recursive: true, force: true });
  rmSync(rig.homeDir, { recursive: true, force: true });
}

async function hook(rig: Rig, at: number, event: string, extra: Record<string, unknown> = {}): Promise<void> {
  rig.t.now = at;
  await handleHook({ session_id: "s1", cwd: "/repo", hook_event_name: event, ...extra }, rig.deps);
}

/** The statusline writing a session total. */
function total(rig: Rig, usd: number, updatedAt: number): void {
  writeCost(rig.deps.env, "s1", { totalUsd: usd, updatedAt });
}

function records(rig: Rig): WorkRecord[] {
  const file = join(rig.kankakuDir, "worklog.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as WorkRecord);
}

function stateOf(rig: Rig) {
  return readState(resolvePaths({ env: rig.deps.env, cwd: "/repo", sessionId: "s1" }).stateFile);
}

/** One whole prompt: submit at `at`, settle with the given session total at `at + 1000`. */
async function prompt(rig: Rig, at: number, settleTotal: number | undefined, submitTotal?: number): Promise<void> {
  if (submitTotal !== undefined) total(rig, submitTotal, at);
  await hook(rig, at, "UserPromptSubmit", { prompt: `p${at}` });
  if (settleTotal !== undefined) total(rig, settleTotal, at + 900);
  await hook(rig, at + 1000, "Stop", { stop_hook_active: false });
}

test("C1.2 UserPromptSubmit takes costAtStart from the state's costBaseline when it has one", async () => {
  const rig = makeRig();
  try {
    const paths = resolvePaths({ env: rig.deps.env, cwd: "/repo", sessionId: "s1" });
    writeState(paths.stateFile, { pid: 1, parentPid: 2, cwd: "/repo", startedAt: 0, promptOpen: null, permissionOpen: null, costBaseline: 3 });
    total(rig, 5.5, 100);
    await hook(rig, 1000, "UserPromptSubmit", { prompt: "x" });
    assert.equal(stateOf(rig)?.promptOpen?.costAtStart, 3);
    assert.equal(stateOf(rig)?.costBaseline, 3);
  } finally {
    cleanup(rig);
  }
});

test("C1.2 UserPromptSubmit without a baseline falls back to the snapshot at submit", async () => {
  const rig = makeRig();
  try {
    total(rig, 1, 100);
    await hook(rig, 1000, "UserPromptSubmit", { prompt: "x" });
    assert.equal(stateOf(rig)?.promptOpen?.costAtStart, 1);
    assert.equal("costBaseline" in (stateOf(rig) ?? {}), false);
  } finally {
    cleanup(rig);
  }
});

test("C1.3 SessionStart startup with no state sets costBaseline 0", async () => {
  const rig = makeRig();
  try {
    await hook(rig, 0, "SessionStart", { source: "startup" });
    assert.equal(stateOf(rig)?.costBaseline, 0);
  } finally {
    cleanup(rig);
  }
});

test("C1.3 SessionStart resume, clear, fork and an absent source set no baseline when there is no state", async () => {
  for (const extra of [{ source: "resume" }, { source: "clear" }, { source: "fork" }, {}]) {
    const rig = makeRig();
    try {
      await hook(rig, 0, "SessionStart", extra);
      assert.notEqual(stateOf(rig), undefined);
      assert.equal("costBaseline" in (stateOf(rig) ?? {}), false, JSON.stringify(extra));
    } finally {
      cleanup(rig);
    }
  }
});

test("C1.3 SessionStart resume keeps the baseline of the existing state file, and startup on an existing state does not reset it", async () => {
  for (const source of ["resume", "startup"]) {
    const rig = makeRig();
    try {
      const paths = resolvePaths({ env: rig.deps.env, cwd: "/repo", sessionId: "s1" });
      writeState(paths.stateFile, { pid: 1, parentPid: 2, cwd: "/repo", startedAt: 0, promptOpen: null, permissionOpen: null, costBaseline: 4.25 });
      await hook(rig, 0, "SessionStart", { source });
      assert.equal(stateOf(rig)?.costBaseline, 4.25, source);
    } finally {
      cleanup(rig);
    }
  }
});

test("C1.2 PermissionRequest and UserPromptSubmit preserve the baseline in the state file", async () => {
  const rig = makeRig();
  try {
    await hook(rig, 0, "SessionStart", { source: "startup" });
    await hook(rig, 100, "UserPromptSubmit", { prompt: "x" });
    await hook(rig, 200, "PermissionRequest", { tool_use_id: "t", tool_name: "Bash" });
    assert.equal(stateOf(rig)?.costBaseline, 0);
    assert.equal(stateOf(rig)?.permissionOpen, 200);
  } finally {
    cleanup(rig);
  }
});

test("C1.4 Stop settles cost = total - start and moves the baseline to the total", async () => {
  const rig = makeRig();
  try {
    await hook(rig, 0, "SessionStart", { source: "startup" });
    await prompt(rig, 1000, 2.5);
    assert.equal(records(rig)[0]?.usage.cost, 2.5);
    assert.equal(records(rig)[0]?.costObserved, true);
    assert.equal(stateOf(rig)?.costBaseline, 2.5);
  } finally {
    cleanup(rig);
  }
});

test("C1.4 a headless session (no total ever) records no cost and leaves the baseline alone", async () => {
  const rig = makeRig();
  try {
    await hook(rig, 0, "SessionStart", { source: "startup" });
    await prompt(rig, 1000, undefined);
    await prompt(rig, 5000, undefined);
    const all = records(rig);
    assert.equal(all.length, 2);
    for (const record of all) assert.equal(record.costObserved, undefined);
    assert.equal(stateOf(rig)?.costBaseline, 0);
  } finally {
    cleanup(rig);
  }
});

test("C1.4 SessionEnd with an open prompt settles the cost and the chain", async () => {
  const rig = makeRig();
  try {
    await hook(rig, 0, "SessionStart", { source: "startup" });
    total(rig, 1, 10);
    await hook(rig, 1000, "UserPromptSubmit", { prompt: "x" });
    total(rig, 4, 1500);
    await hook(rig, 2000, "SessionEnd", { reason: "exit" });
    const all = records(rig);
    assert.equal(all.length, 1);
    assert.equal(all[0]?.status, "interrupted");
    assert.equal(all[0]?.usage.cost, 4);
    assert.equal(all[0]?.costObserved, true);
  } finally {
    cleanup(rig);
  }
});

test("C1.6 Stop and SessionEnd with no open prompt write nothing and do not move the baseline", async () => {
  const rig = makeRig();
  try {
    await hook(rig, 0, "SessionStart", { source: "startup" });
    await prompt(rig, 1000, 2);
    assert.equal(records(rig).length, 1);
    total(rig, 9, 5000);
    await hook(rig, 6000, "Stop", { stop_hook_active: false });
    assert.equal(records(rig).length, 1);
    assert.equal(stateOf(rig)?.costBaseline, 2);
    await hook(rig, 7000, "SessionEnd", { reason: "exit" });
    assert.equal(records(rig).length, 1);
  } finally {
    cleanup(rig);
  }
});

async function conservationSession(rig: Rig, source: string): Promise<void> {
  await hook(rig, 0, "SessionStart", { source });
  await prompt(rig, 1000, 3.0, 1.0); // A: total 1.00 at submit, 3.00 at settle
  total(rig, 5.5, 3500); // spend between prompts, no prompt open
  await prompt(rig, 5000, 6.0); // B
  total(rig, 6.4, 6500); // late refresh after B's settle
  await prompt(rig, 9000, 7.0); // C
}

test("C1.5 conservation: a startup session's record costs sum to the final total", async () => {
  const rig = makeRig();
  try {
    await conservationSession(rig, "startup");
    const costs = records(rig).map((r) => r.usage.cost);
    assert.deepEqual(costs, [3, 3, 1]);
    assert.equal(Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6, 7);
  } finally {
    cleanup(rig);
  }
});

test("C1.5 a resumed session with no state file measures its first prompt from the snapshot at submit", async () => {
  const rig = makeRig();
  try {
    await conservationSession(rig, "resume");
    assert.deepEqual(records(rig).map((r) => r.usage.cost), [2, 3, 1]);
  } finally {
    cleanup(rig);
  }
});

test("C1.5 counter reset: a total below the baseline records the new total", async () => {
  const rig = makeRig();
  try {
    await conservationSession(rig, "startup");
    await prompt(rig, 13000, 0.5); // total drops from 7.00 to 0.50
    assert.equal(records(rig).at(-1)?.usage.cost, 0.5);
    assert.equal(stateOf(rig)?.costBaseline, 0.5);
    await prompt(rig, 17000, 1.25);
    assert.equal(records(rig).at(-1)?.usage.cost, 0.75);
  } finally {
    cleanup(rig);
  }
});
