import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkRecord } from "kankaku-pi/domain";
import { handleHook, type HandleHookDeps } from "../src/handle-hook.ts";
import { writeState } from "../src/session-state.ts";
import { recoverStaleSessions } from "../src/inflight-recovery.ts";
import { appendEvent } from "../src/event-log.ts";
import { readPriceBook, writePriceBook, emptyPriceBook } from "../src/price-book.ts";

// Synthetic transcripts: only the SHAPES of a Claude Code transcript.
function message(id: string, entrypoint: string, u: { in?: number; out?: number; cr?: number; w1h?: number }, model = "model-a"): string {
  return `${JSON.stringify({
    type: "assistant",
    entrypoint,
    version: "2.5.0",
    message: {
      id,
      model,
      usage: {
        input_tokens: u.in ?? 0,
        output_tokens: u.out ?? 0,
        cache_read_input_tokens: u.cr ?? 0,
        cache_creation_input_tokens: u.w1h ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: u.w1h ?? 0 },
      },
    },
  })}\n`;
}

// $4 / $20 / $0.20 / $8 per million tokens.
const PRICES = { input: 4, output: 20, cacheRead: 0.2, cacheWrite1h: 8 };

interface Env {
  kankakuDir: string;
  homeDir: string;
  projectDir: string;
  transcript: string;
  deps: HandleHookDeps;
  set: (t: number) => void;
}

function setup(): Env {
  const kankakuDir = mkdtempSync(join(tmpdir(), "kankaku-desktop-"));
  const homeDir = mkdtempSync(join(tmpdir(), "kankaku-desktop-home-"));
  const projectDir = mkdtempSync(join(tmpdir(), "kankaku-desktop-proj-"));
  const transcript = join(projectDir, "session-1.jsonl");
  let current = 0;
  const deps: HandleHookDeps = {
    env: { KANKAKU_DIR: kankakuDir, HOME: homeDir },
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
    isAlive: () => true,
    runPs: () => ({ ppid: 42, comm: "claude" }),
    stderr: () => {},
    autoSync: async () => {},
  };
  return { kankakuDir, homeDir, projectDir, transcript, deps, set: (t) => (current = t) };
}

function cleanup(env: Env): void {
  for (const dir of [env.kankakuDir, env.homeDir, env.projectDir]) rmSync(dir, { recursive: true, force: true });
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

function learnedPrices(env: Env): void {
  writePriceBook({ HOME: env.homeDir }, { version: 1, models: { "model-a": { samples: [], prices: PRICES } } });
}

async function onePrompt(env: Env, lines: string): Promise<void> {
  env.set(0);
  await handleHook(input(env, { hook_event_name: "SessionStart", source: "startup" }), env.deps);
  env.set(1000);
  await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt: "go" }), env.deps);
  writeFileSync(env.transcript, lines);
  env.set(2000);
  await handleHook(input(env, { hook_event_name: "Stop", stop_hook_active: false }), env.deps);
}

test("a desktop-app (sdk-ts) prompt is priced from the learned prices at Stop", async () => {
  const env = setup();
  try {
    learnedPrices(env);
    await onePrompt(env, message("m1", "sdk-ts", { in: 1000, out: 2000, cr: 100_000, w1h: 50_000 }));
    const [record] = worklog(env);
    // 1000*4 + 2000*20 + 100000*0.2 + 50000*8 = 464000 micro-dollars.
    assert.ok(Math.abs((record?.usage.cost ?? 0) - 0.464) < 1e-9, String(record?.usage.cost));
    assert.equal(record?.costObserved, true);
    assert.deepEqual({ input: record?.usage.input, output: record?.usage.output }, { input: 1000, output: 2000 });
  } finally {
    cleanup(env);
  }
});

test("a desktop-app prompt stays without cost when a model or category it used has no learned price", async () => {
  const env = setup();
  try {
    learnedPrices(env);
    await onePrompt(env, message("m1", "sdk-ts", { out: 10 }) + message("m2", "sdk-ts", { out: 10 }, "model-new"));
    const [record] = worklog(env);
    assert.equal(record?.usage.cost, 0);
    assert.equal(record?.costObserved, undefined);
  } finally {
    cleanup(env);
  }
});

test("a terminal (cli) prompt without a statusline cost is not priced from the learned prices", async () => {
  const env = setup();
  try {
    learnedPrices(env);
    await onePrompt(env, message("m1", "cli", { in: 1000, out: 2000 }));
    const [record] = worklog(env);
    assert.equal(record?.usage.cost, 0);
    assert.equal(record?.costObserved, undefined);
  } finally {
    cleanup(env);
  }
});

function costState(t: { in: number; out: number; cr: number; w1h: number }, cost: number, model = "model-a"): string {
  return `${JSON.stringify({
    type: "cost-state",
    totalCostUSD: cost,
    hasUnknownModelCost: false,
    modelUsage: { [model]: { inputTokens: t.in, outputTokens: t.out, cacheReadInputTokens: t.cr, cacheCreationInputTokens: t.w1h, costUSD: cost } },
  })}\n`;
}

test("SessionEnd learns from the closed session's cost-state, under HOME, and prices its open desktop prompt", async () => {
  const env = setup();
  try {
    // Five earlier sessions already taught model-a (one more than its four unknowns is still needed).
    let book = emptyPriceBook();
    const { recordSample } = await import("../src/price-book.ts");
    const seeds = [
      { input: 1000, output: 2000, cacheRead: 300000, cacheWrite1h: 40000 },
      { input: 5000, output: 100, cacheRead: 10000, cacheWrite1h: 1000 },
      { input: 200, output: 9000, cacheRead: 50000, cacheWrite1h: 80000 },
      { input: 7000, output: 3000, cacheRead: 900000, cacheWrite1h: 5000 },
    ];
    seeds.forEach((t, i) => {
      const tokens = { ...t, cacheWrite5m: 0, cacheWriteUnsplit: 0 };
      const costUsd = (t.input * 4 + t.output * 20 + t.cacheRead * 0.2 + t.cacheWrite1h * 8) / 1e6;
      book = recordSample(book, "model-a", { sessionId: `old-${i}`, at: 1, tokens, costUsd }, 1);
    });
    writePriceBook({ HOME: env.homeDir }, book);
    assert.equal(readPriceBook({ HOME: env.homeDir }).models["model-a"]?.prices, undefined);

    env.set(0);
    await handleHook(input(env, { hook_event_name: "SessionStart", source: "startup" }), env.deps);
    env.set(1000);
    await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt: "go" }), env.deps);
    const t = { in: 300, out: 600, cr: 1000, w1h: 100 };
    const cost = (t.in * 4 + t.out * 20 + t.cr * 0.2 + t.w1h * 8) / 1e6;
    writeFileSync(env.transcript, message("m1", "sdk-ts", t) + costState(t, cost));
    env.set(5000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);

    const learned = readPriceBook({ HOME: env.homeDir }).models["model-a"];
    assert.equal(learned?.samples.length, 5);
    assert.ok(Math.abs((learned?.prices?.output ?? 0) - 20) < 1e-6);
    const [record] = worklog(env);
    assert.equal(record?.status, "interrupted");
    assert.ok(Math.abs((record?.usage.cost ?? 0) - cost) < 1e-9, String(record?.usage.cost));
    assert.equal(record?.costObserved, true);
    assert.equal(existsSync(join(env.projectDir, ".kankaku")), false);
  } finally {
    cleanup(env);
  }
});

test("SessionEnd with no open prompt still learns from the transcript", async () => {
  const env = setup();
  try {
    env.set(0);
    await handleHook(input(env, { hook_event_name: "SessionStart", source: "startup" }), env.deps);
    const t = { in: 300, out: 600, cr: 1000, w1h: 100 };
    writeFileSync(env.transcript, message("m1", "cli", t) + costState(t, 0.01));
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "other" }), env.deps);
    assert.equal(readPriceBook({ HOME: env.homeDir }).models["model-a"]?.samples.length, 1);
    assert.deepEqual(worklog(env), []);
  } finally {
    cleanup(env);
  }
});

test("recovery learns from a dead session and prices its interrupted desktop prompt", () => {
  const env = setup();
  try {
    learnedPrices(env);
    const claudeDir = join(env.kankakuDir, "claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(env.transcript, message("m1", "sdk-ts", { in: 1000, out: 1000 }));
    writeState(join(claudeDir, "dead.state.json"), {
      pid: 9999,
      parentPid: 1,
      cwd: "/repo",
      startedAt: 0,
      promptOpen: { id: "p", startedAt: 1000, costAtStart: undefined },
      permissionOpen: null,
      transcript: { path: env.transcript, offsets: { [env.transcript]: { bytes: 0 } } },
    });
    appendEvent(join(claudeDir, "dead.events.jsonl"), { ts: 1000, event: "UserPromptSubmit", prompt: "cut off" });
    appendFileSync(env.transcript, costState({ in: 1000, out: 1000, cr: 0, w1h: 0 }, 0.024));

    const records = recoverStaleSessions({ claudeDir, currentSessionId: "other", isAlive: () => false, now: 50_000, env: env.deps.env });
    assert.equal(records.length, 1);
    assert.ok(Math.abs((records[0]?.usage.cost ?? 0) - 0.024) < 1e-9, String(records[0]?.usage.cost));
    assert.equal(records[0]?.costObserved, true);
    assert.equal(readPriceBook({ HOME: env.homeDir }).models["model-a"]?.samples.length, 1);
  } finally {
    cleanup(env);
  }
});
