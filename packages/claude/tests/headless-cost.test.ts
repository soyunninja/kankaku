import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkRecord } from "kankaku-pi/domain";
import { isWorkRecord } from "kankaku-pi/domain";
import { handleHook, type HandleHookDeps } from "../src/handle-hook.ts";
import { readState, writeState } from "../src/session-state.ts";
import { resolvePaths } from "../src/paths.ts";
import { recoverStaleSessions } from "../src/inflight-recovery.ts";
import { appendEvent } from "../src/event-log.ts";
import { allocateCost } from "../src/headless.ts";

// ---- allocateCost (pure) ----

test("allocateCost gives a single prompt the whole cost", () => {
  assert.deepEqual(allocateCost(0.42, [10]), [0.42]);
});

test("allocateCost shares in proportion to the weights and the shares add up exactly", () => {
  assert.deepEqual(allocateCost(0.09, [22, 66]), [0.0225, 0.0675]);
  const shares = allocateCost(0.1, [1, 1, 1]);
  assert.deepEqual(shares, [0.033333, 0.033333, 0.033334]);
  assert.equal(Math.round(shares.reduce((a, b) => a + b, 0) * 1e6), 100000);
});

test("allocateCost splits equally when every weight is zero, remainder on the last", () => {
  assert.deepEqual(allocateCost(0.000005, [0, 0]), [0.000002, 0.000003]);
});

test("allocateCost of a zero total is all zeros, and of no prompts is empty", () => {
  assert.deepEqual(allocateCost(0, [3, 4]), [0, 0]);
  assert.deepEqual(allocateCost(1, []), []);
});

test("allocateCost stays exact for very large weights", () => {
  const shares = allocateCost(123.456789, [9_000_000_000_000, 1_000_000_000_000, 5]);
  assert.equal(Math.round(shares.reduce((a, b) => a + b, 0) * 1e6), 123456789);
  assert.ok(shares.every((share) => share >= 0));
});

// ---- hooks ----

function assistant(id: string, input: number, output: number, meta: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: "assistant", ...meta, message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: input * 10, cache_creation_input_tokens: output * 10 } } })}\n`;
}

function costState(total: unknown, unknown_ = false): string {
  return `${JSON.stringify({ type: "cost-state", totalCostUSD: total, hasUnknownModelCost: unknown_, modelUsage: {} })}\n`;
}

const HEADLESS = { version: "2.5.0", entrypoint: "sdk-cli" };

interface Env {
  kankakuDir: string;
  homeDir: string;
  projectDir: string;
  transcript: string;
  deps: HandleHookDeps;
  set: (t: number) => void;
  sleeps: number[];
  syncs: string[];
}

function setup(): Env {
  const kankakuDir = mkdtempSync(join(tmpdir(), "kankaku-headless-"));
  const homeDir = mkdtempSync(join(tmpdir(), "kankaku-headless-home-"));
  const projectDir = mkdtempSync(join(tmpdir(), "kankaku-headless-proj-"));
  mkdirSync(join(projectDir, "session-1", "subagents"), { recursive: true });
  let current = 0;
  const sleeps: number[] = [];
  const syncs: string[] = [];
  const deps: HandleHookDeps = {
    env: { KANKAKU_DIR: kankakuDir, HOME: homeDir },
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms);
      current += ms;
    },
    isAlive: () => true,
    runPs: () => ({ ppid: 42, comm: "claude" }),
    stderr: () => {},
    autoSync: async (trigger) => {
      syncs.push(trigger);
    },
  };
  return { kankakuDir, homeDir, projectDir, transcript: join(projectDir, "session-1.jsonl"), deps, set: (t) => (current = t), sleeps, syncs };
}

function cleanup(env: Env): void {
  rmSync(env.kankakuDir, { recursive: true, force: true });
  rmSync(env.homeDir, { recursive: true, force: true });
  rmSync(env.projectDir, { recursive: true, force: true });
}

function input(env: Env, overrides: Record<string, unknown>): Record<string, unknown> {
  return { session_id: "session-1", cwd: "/repo", transcript_path: env.transcript, ...overrides };
}

function worklog(env: Env): WorkRecord[] {
  const file = join(env.kankakuDir, "worklog.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as WorkRecord);
}

function paths(env: Env) {
  return resolvePaths({ env: env.deps.env, cwd: "/repo", sessionId: "session-1" });
}

/** A headless run: one prompt per call, transcript growth between UserPromptSubmit and Stop. */
async function headlessPrompt(env: Env, startTs: number, lines: string, prompt = "go"): Promise<void> {
  env.set(startTs);
  await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt }), env.deps);
  appendFileSync(env.transcript, lines);
  env.set(startTs + 1000);
  await handleHook(input(env, { hook_event_name: "Stop", stop_hook_active: false }), env.deps);
}

async function startHeadless(env: Env): Promise<void> {
  writeFileSync(env.transcript, "");
  env.set(0);
  await handleHook(input(env, { hook_event_name: "SessionStart", source: "startup" }), env.deps);
}

test("a headless Stop keeps the settled prompt pending instead of writing the record, and does not wait for a statusline cost", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 2, 3, HEADLESS));

    assert.equal(worklog(env).length, 0);
    assert.deepEqual(env.sleeps, []);
    assert.equal(env.syncs.includes("agent_settled"), false);
    const state = readState(paths(env).stateFile);
    assert.equal(state?.promptOpen, null);
    assert.equal(state?.pending?.length, 1);
    const pending = state?.pending?.[0];
    assert.equal(pending?.costAtStart, 0);
    assert.equal(pending?.core.status, "completed");
    assert.equal(pending?.core.wallMs, 1000);
    assert.deepEqual(pending?.core.usage, { input: 2, output: 3, cacheRead: 20, cacheWrite: 30, cost: 0 });
    // The events of the settled prompt are dropped like for any other settle.
    assert.equal(existsSync(paths(env).eventsFile), true);
  } finally {
    cleanup(env);
  }
});

test("SessionEnd writes the pending headless record with the transcript cost, tokens and version, then cleans up", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 2, 3, HEADLESS));
    appendFileSync(env.transcript, costState(0.42));
    env.set(3000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);

    const [record, ...rest] = worklog(env);
    assert.equal(rest.length, 0);
    assert.equal(isWorkRecord(record), true);
    assert.equal(record?.status, "completed");
    assert.equal(record?.usage.cost, 0.42);
    assert.equal(record?.costObserved, true);
    assert.equal(record?.costAllocated, undefined);
    assert.deepEqual([record?.usage.input, record?.usage.output, record?.usage.cacheRead, record?.usage.cacheWrite], [2, 3, 20, 30]);
    assert.equal(record?.agentVersion, "2.5.0");
    assert.equal(record?.agent, "claude-code");
    assert.equal(record?.sessionId, "session-1");
    assert.equal(record?.wallMs, 1000);
    assert.equal(existsSync(paths(env).stateFile), false);
    assert.equal(env.syncs.at(-1), "session_shutdown");
  } finally {
    cleanup(env);
  }
});

test("SessionEnd without a cost-state writes the record without cost", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 2, 3, HEADLESS));
    env.set(3000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);

    const [record] = worklog(env);
    assert.equal(worklog(env).length, 1);
    assert.equal(record?.usage.cost, 0);
    assert.equal(record?.costObserved, undefined);
    assert.equal(record?.usage.input, 2);
  } finally {
    cleanup(env);
  }
});

test("a cost-state that flags an unknown model cost is not trusted as a cost", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 2, 3, HEADLESS));
    appendFileSync(env.transcript, costState(0.42, true));
    env.set(3000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);

    const [record] = worklog(env);
    assert.equal(record?.costObserved, undefined);
    assert.equal(record?.usage.cost, 0);
    assert.equal(record?.usage.output, 3);
  } finally {
    cleanup(env);
  }
});

test("several pending prompts share the session cost in proportion to their tokens and are marked allocated", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 1, 1, HEADLESS), "one");
    await headlessPrompt(env, 3000, assistant("m2", 3, 3), "two");
    appendFileSync(env.transcript, costState(0.09));
    env.set(5000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);

    const records = worklog(env);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.usage.cost), [0.0225, 0.0675]);
    assert.deepEqual(records.map((r) => r.costObserved), [true, true]);
    assert.deepEqual(records.map((r) => r.costAllocated), [true, true]);
    assert.deepEqual(records.map((r) => r.prompt), ["one", "two"]);
  } finally {
    cleanup(env);
  }
});

test("the session baseline is applied: the cost is the total minus the baseline the prompt started from", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    const p = paths(env);
    writeState(p.stateFile, { ...readState(p.stateFile)!, costBaseline: 1 });
    await headlessPrompt(env, 1000, assistant("m1", 2, 3, HEADLESS));
    appendFileSync(env.transcript, costState(3.5));
    env.set(3000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);
    assert.equal(worklog(env)[0]?.usage.cost, 2.5);
  } finally {
    cleanup(env);
  }
});

test("an interactive entrypoint or an unreadable one keeps writing the record at Stop", async () => {
  for (const meta of [{ version: "2.5.0", entrypoint: "cli" }, {}]) {
    const env = setup();
    try {
      await startHeadless(env);
      await headlessPrompt(env, 1000, assistant("m1", 2, 3, meta));
      assert.equal(worklog(env).length, 1);
      assert.equal(readState(paths(env).stateFile)?.pending, undefined);
      assert.ok(env.sleeps.length > 0, "the statusline cost wait still runs");
    } finally {
      cleanup(env);
    }
  }
});

test("SessionEnd of a headless session whose prompt never reached Stop writes it as interrupted, with the cost", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 1, 1, HEADLESS), "one");
    env.set(3000);
    await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt: "two" }), env.deps);
    appendFileSync(env.transcript, assistant("m2", 1, 1) + costState(0.02));
    env.set(4000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);

    const records = worklog(env);
    assert.deepEqual(records.map((r) => r.status), ["completed", "interrupted"]);
    assert.equal(Math.round(records.reduce((sum, r) => sum + r.usage.cost, 0) * 1e6), 20000);
    assert.deepEqual(records.map((r) => r.costAllocated), [true, true]);
  } finally {
    cleanup(env);
  }
});

test("recovery of a dead headless session writes its pending records with the cost", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 2, 3, HEADLESS));
    appendFileSync(env.transcript, costState(0.42));
    // SessionEnd never ran: the state, events and pending list are all still on disk.

    const records = recoverStaleSessions({
      claudeDir: paths(env).claudeDir,
      currentSessionId: "other",
      isAlive: () => false,
      now: 9000,
      env: env.deps.env,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "completed");
    assert.equal(records[0]?.usage.cost, 0.42);
    assert.equal(records[0]?.costObserved, true);
    assert.equal(records[0]?.usage.input, 2);
    assert.equal(records[0]?.agentVersion, "2.5.0");
    assert.equal(existsSync(paths(env).stateFile), false);
  } finally {
    cleanup(env);
  }
});

test("recovery of a dead headless session with a settled and an open prompt: completed and interrupted, sharing the cost", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 1, 1, HEADLESS), "one");
    env.set(3000);
    await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt: "two" }), env.deps);
    appendFileSync(env.transcript, assistant("m2", 1, 1) + costState(0.02));

    const records = recoverStaleSessions({
      claudeDir: paths(env).claudeDir,
      currentSessionId: "other",
      isAlive: () => false,
      now: 9000,
      env: env.deps.env,
    });
    assert.deepEqual(records.map((r) => r.status), ["completed", "interrupted"]);
    assert.deepEqual(records.map((r) => r.usage.cost), [0.01, 0.01]);
    assert.deepEqual(records.map((r) => r.costAllocated), [true, true]);
  } finally {
    cleanup(env);
  }
});

test("a headless prompt is written exactly once when SessionEnd runs first and recovery later", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 2, 3, HEADLESS));
    appendFileSync(env.transcript, costState(0.42));
    env.set(3000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);

    const recovered = recoverStaleSessions({ claudeDir: paths(env).claudeDir, currentSessionId: "other", isAlive: () => false, now: 9000, env: env.deps.env });
    assert.equal(recovered.length, 0);
    assert.equal(worklog(env).length, 1);
  } finally {
    cleanup(env);
  }
});

test("a headless prompt is written exactly once when recovery runs first and SessionEnd later", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 2, 3, HEADLESS));
    appendFileSync(env.transcript, costState(0.42));

    const recovered = recoverStaleSessions({ claudeDir: paths(env).claudeDir, currentSessionId: "other", isAlive: () => false, now: 9000, env: env.deps.env });
    assert.equal(recovered.length, 1);
    env.set(10000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);
    assert.equal(worklog(env).length, 0, "recovery returns the records for the caller to append; SessionEnd must add none");
  } finally {
    cleanup(env);
  }
});

test("SessionEnd clears the pending list from the state as soon as the records are written", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 2, 3, HEADLESS));
    // While the shutdown sync runs the records are on disk and the state must no longer hold them,
    // so a crash after the append can never make recovery write them a second time.
    const seen: Array<{ records: number; pending: unknown }> = [];
    env.deps.autoSync = async () => {
      seen.push({ records: worklog(env).length, pending: readState(paths(env).stateFile)?.pending });
    };
    env.set(3000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);
    assert.deepEqual(seen, [{ records: 1, pending: undefined }]);
  } finally {
    cleanup(env);
  }
});

test("a headless prompt without a readable transcript still yields its record at SessionEnd, without tokens or cost", async () => {
  const env = setup();
  try {
    await startHeadless(env);
    await headlessPrompt(env, 1000, assistant("m1", 2, 3, HEADLESS));
    rmSync(env.transcript);
    env.set(3000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);
    const [record] = worklog(env);
    assert.equal(worklog(env).length, 1);
    assert.equal(record?.costObserved, undefined);
    assert.equal(record?.usage.input, 2, "the tokens were already read at Stop");
  } finally {
    cleanup(env);
  }
});
