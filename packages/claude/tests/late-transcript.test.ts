import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkRecord } from "kankaku-pi/domain";
import { handleHook, type HandleHookDeps } from "../src/handle-hook.ts";
import { readState } from "../src/session-state.ts";
import { resolvePaths } from "../src/paths.ts";
import { recoverStaleSessions } from "../src/inflight-recovery.ts";
import { writeCost } from "../src/cost-store.ts";

// Claude Code writes the transcript asynchronously: the last assistant lines
// reach the disk shortly AFTER the Stop hook has started. Synthetic shapes only.
function user(meta: Record<string, unknown>): string {
  return `${JSON.stringify({ type: "user", ...meta })}\n`;
}
function assistant(id: string, input: number, output: number, model = "model-x"): string {
  return `${JSON.stringify({ type: "assistant", message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: input * 10, cache_creation_input_tokens: output * 10 } } })}\n`;
}
function costState(total: number): string {
  return `${JSON.stringify({ type: "cost-state", totalCostUSD: total, hasUnknownModelCost: false, modelUsage: {} })}\n`;
}

const HEADLESS = { version: "2.5.0", entrypoint: "sdk-cli" };
const INTERACTIVE = { version: "2.5.0", entrypoint: "cli" };

interface Env {
  kankakuDir: string;
  homeDir: string;
  projectDir: string;
  transcript: string;
  deps: HandleHookDeps;
  set: (t: number) => void;
  clock: () => number;
  /** Runs after every sleep with the fake clock's time. */
  onSleep: { current: ((now: number) => void) | undefined };
}

function setup(): Env {
  const kankakuDir = mkdtempSync(join(tmpdir(), "kankaku-late-"));
  const homeDir = mkdtempSync(join(tmpdir(), "kankaku-late-home-"));
  const projectDir = mkdtempSync(join(tmpdir(), "kankaku-late-proj-"));
  mkdirSync(join(projectDir, "session-1", "subagents"), { recursive: true });
  let current = 0;
  const onSleep: Env["onSleep"] = { current: undefined };
  const deps: HandleHookDeps = {
    env: { KANKAKU_DIR: kankakuDir, HOME: homeDir },
    now: () => current,
    sleep: async (ms) => {
      current += ms;
      onSleep.current?.(current);
    },
    isAlive: () => true,
    runPs: () => ({ ppid: 42, comm: "claude" }),
    stderr: () => {},
    autoSync: async () => {},
  };
  return { kankakuDir, homeDir, projectDir, transcript: join(projectDir, "session-1.jsonl"), deps, set: (t) => (current = t), clock: () => current, onSleep };
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

const paths = (env: Env) => resolvePaths({ env: env.deps.env, cwd: "/repo", sessionId: "session-1" });

async function start(env: Env, meta: Record<string, unknown>): Promise<void> {
  writeFileSync(env.transcript, user(meta));
  env.set(0);
  await handleHook(input(env, { hook_event_name: "SessionStart", source: "startup" }), env.deps);
}

async function submit(env: Env, ts: number, prompt = "go"): Promise<void> {
  env.set(ts);
  await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt }), env.deps);
}

async function stop(env: Env, ts: number): Promise<void> {
  env.set(ts);
  await handleHook(input(env, { hook_event_name: "Stop", stop_hook_active: false }), env.deps);
}

/** A fresh statusline cost so the interactive Stop does not wait for one. */
function freshCost(env: Env, total: number, ts: number, model?: string): void {
  writeCost(env.deps.env, "session-1", { totalUsd: total, updatedAt: ts, ...(model ? { model } : {}) });
}

test("headless: the assistant line and the cost-state written after Stop are counted at SessionEnd", async () => {
  const env = setup();
  try {
    await start(env, HEADLESS);
    await submit(env, 1000);
    await stop(env, 2000); // nothing but the user line on disk yet
    appendFileSync(env.transcript, assistant("m1", 10, 42) + costState(0.018505));
    env.set(4000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);

    const [record] = worklog(env);
    assert.equal(worklog(env).length, 1);
    assert.deepEqual(record?.usage, { input: 10, output: 42, cacheRead: 100, cacheWrite: 420, cost: 0.018505 });
    assert.equal(record?.costObserved, true);
    assert.equal(record?.agentVersion, "2.5.0");
    assert.equal(record?.model, "anthropic/model-x");
    assert.equal(record?.status, "completed");
    assert.equal(existsSync(paths(env).stateFile), false);
  } finally {
    cleanup(env);
  }
});

test("headless: late usage goes to the LAST pending prompt and the allocation uses the final token totals", async () => {
  const env = setup();
  try {
    await start(env, HEADLESS);
    await submit(env, 1000, "one");
    appendFileSync(env.transcript, assistant("m1", 1, 1));
    await stop(env, 2000);
    await submit(env, 3000, "two");
    await stop(env, 4000); // the second prompt's lines are not on disk yet
    appendFileSync(env.transcript, assistant("m2", 3, 3) + costState(0.09));
    env.set(6000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);

    const records = worklog(env);
    assert.deepEqual(records.map((r) => r.prompt), ["one", "two"]);
    assert.deepEqual(records.map((r) => r.usage.input), [1, 3]);
    assert.deepEqual(records.map((r) => r.usage.cost), [0.0225, 0.0675]);
    assert.deepEqual(records.map((r) => r.costAllocated), [true, true]);
  } finally {
    cleanup(env);
  }
});

test("headless: lines seen during the Stop wait and again at SessionEnd are counted once", async () => {
  const env = setup();
  try {
    await start(env, HEADLESS);
    await submit(env, 1000);
    env.onSleep.current = (now) => {
      if (now >= 2050 && !existsSync(`${env.transcript}.done`)) {
        writeFileSync(`${env.transcript}.done`, "");
        appendFileSync(env.transcript, assistant("m1", 10, 42));
      }
    };
    await stop(env, 2000);
    env.onSleep.current = undefined;
    // The message grows after the wait, and a second one arrives.
    appendFileSync(env.transcript, assistant("m1", 10, 50) + assistant("m2", 1, 1) + costState(0.5));
    env.set(4000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);

    const [record] = worklog(env);
    assert.deepEqual([record?.usage.input, record?.usage.output], [11, 51]);
    assert.equal(record?.usage.cost, 0.5);
  } finally {
    cleanup(env);
  }
});

test("interactive: lines that arrive within the bounded wait are counted at Stop", async () => {
  const env = setup();
  try {
    await start(env, INTERACTIVE);
    await submit(env, 1000);
    freshCost(env, 0.2, 1500, "claude-statusline");
    const started = 2000;
    env.onSleep.current = (now) => {
      if (now >= started + 50 && !existsSync(`${env.transcript}.done`)) {
        writeFileSync(`${env.transcript}.done`, "");
        appendFileSync(env.transcript, assistant("m1", 10, 42));
      }
    };
    await stop(env, started);

    const [record] = worklog(env);
    assert.deepEqual([record?.usage.input, record?.usage.output], [10, 42]);
    assert.equal(record?.model, "anthropic/claude-statusline", "the statusline model wins");
    assert.ok(env.clock() - started < 300, `waited ${env.clock() - started} ms`);
  } finally {
    cleanup(env);
  }
});

test("interactive: nothing arriving gives up at 300 ms and the record is still written; the late usage lands in the next record", async () => {
  const env = setup();
  try {
    await start(env, INTERACTIVE);
    await submit(env, 1000);
    freshCost(env, 0.2, 1500);
    await stop(env, 2000);
    assert.equal(env.clock() - 2000, 300);
    assert.equal(worklog(env).length, 1);
    assert.equal(worklog(env)[0]?.usage.input, 0);

    appendFileSync(env.transcript, assistant("late", 7, 8));
    await submit(env, 5000, "two");
    freshCost(env, 0.4, 5500);
    appendFileSync(env.transcript, assistant("m2", 1, 1));
    await stop(env, 6000);
    const records = worklog(env);
    assert.equal(records.length, 2);
    assert.deepEqual([records[1]?.usage.input, records[1]?.usage.output], [8, 9]);
  } finally {
    cleanup(env);
  }
});

test("interactive: the model comes from the transcript when there is no statusline model", async () => {
  const env = setup();
  try {
    await start(env, INTERACTIVE);
    await submit(env, 1000);
    appendFileSync(env.transcript, assistant("m1", 1, 1, "claude-from-transcript"));
    await stop(env, 2000);
    assert.equal(worklog(env)[0]?.model, "anthropic/claude-from-transcript");
  } finally {
    cleanup(env);
  }
});

test("headless: without a start baseline the cost stays unobserved (chained rule), tokens still land", async () => {
  const env = setup();
  try {
    writeFileSync(env.transcript, user(HEADLESS));
    env.set(0);
    await handleHook(input(env, { hook_event_name: "SessionStart", source: "resume" }), env.deps);
    await submit(env, 1000);
    await stop(env, 2000);
    appendFileSync(env.transcript, assistant("m1", 2, 3) + costState(0.3));
    env.set(4000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);
    const [record] = worklog(env);
    assert.equal(record?.costObserved, undefined);
    assert.equal(record?.usage.input, 2);
  } finally {
    cleanup(env);
  }
});

test("recovery adds late usage to the last pending prompt and takes the model from the transcript", async () => {
  const env = setup();
  try {
    await start(env, HEADLESS);
    await submit(env, 1000);
    await stop(env, 2000);
    appendFileSync(env.transcript, assistant("m1", 4, 5, "claude-r") + costState(0.25));

    const records = recoverStaleSessions({ claudeDir: paths(env).claudeDir, currentSessionId: "other", isAlive: () => false, now: 9000, env: env.deps.env });
    assert.equal(records.length, 1);
    assert.deepEqual([records[0]?.usage.input, records[0]?.usage.output, records[0]?.usage.cost], [4, 5, 0.25]);
    assert.equal(records[0]?.model, "anthropic/claude-r");
    assert.equal(readState(paths(env).stateFile), undefined);
  } finally {
    cleanup(env);
  }
});


test("interactive: an earlier assistant line is on disk and the prompt's last one lands at 60 ms: it belongs to this record", async () => {
  const env = setup();
  try {
    await start(env, INTERACTIVE);
    await submit(env, 1000);
    appendFileSync(env.transcript, assistant("m1", 1, 1));
    freshCost(env, 0.2, 1500);
    const started = 2000;
    env.onSleep.current = (now) => {
      if (now >= started + 60 && !existsSync(`${env.transcript}.done`)) {
        writeFileSync(`${env.transcript}.done`, "");
        appendFileSync(env.transcript, assistant("m2", 10, 20));
      }
    };
    await stop(env, started);
    const [record] = worklog(env);
    assert.deepEqual([record?.usage.input, record?.usage.output], [11, 21]);
  } finally {
    cleanup(env);
  }
});

test("interactive: a line that lands after the wait is counted by the next settle", async () => {
  const env = setup();
  try {
    await start(env, INTERACTIVE);
    await submit(env, 1000);
    appendFileSync(env.transcript, assistant("m1", 1, 1));
    freshCost(env, 0.2, 1500);
    env.onSleep.current = (now) => {
      if (now >= 2320 && !existsSync(`${env.transcript}.done`)) {
        writeFileSync(`${env.transcript}.done`, "");
        appendFileSync(env.transcript, assistant("m2", 10, 20));
      }
    };
    await stop(env, 2000);
    assert.equal(env.clock() - 2000, 100, "a stable line on disk ends the wait at 100 ms");
    env.onSleep.current = undefined;
    appendFileSync(env.transcript, assistant("m2", 10, 20));
    await submit(env, 5000, "two");
    freshCost(env, 0.4, 5500);
    await stop(env, 6000);
    const records = worklog(env);
    assert.equal(records[0]?.usage.input, 1);
    assert.equal(records[1]?.usage.input, 10);
  } finally {
    cleanup(env);
  }
});

test("interactive: a statusline wait that already took 400 ms leaves no further transcript wait", async () => {
  const env = setup();
  try {
    await start(env, INTERACTIVE);
    await submit(env, 1000);
    appendFileSync(env.transcript, assistant("m1", 1, 1));
    const started = 2000;
    const sleepsAfterCost: number[] = [];
    env.onSleep.current = (now) => {
      if (now >= started + 400 && readCostFile(env) === undefined) freshCost(env, 0.2, started + 400);
      else if (readCostFile(env) !== undefined) sleepsAfterCost.push(now);
    };
    await stop(env, started);
    assert.equal(worklog(env).length, 1);
    assert.deepEqual(sleepsAfterCost, [], "no sleep after the statusline cost arrived");
    assert.equal(env.clock() - started, 400);
  } finally {
    cleanup(env);
  }
});

function readCostFile(env: Env): number | undefined {
  const file = join(env.homeDir, ".kankaku", "claude", "cost", "session-1.json");
  return existsSync(file) ? 1 : undefined;
}
