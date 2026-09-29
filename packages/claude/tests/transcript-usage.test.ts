import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkRecord } from "kankaku-pi/domain";
import type { WorkRecord } from "kankaku-pi/domain";
import { handleHook, type HandleHookDeps } from "../src/handle-hook.ts";
import { readState, writeState } from "../src/session-state.ts";
import { resolvePaths } from "../src/paths.ts";
import { recoverStaleSessions } from "../src/inflight-recovery.ts";
import { appendEvent } from "../src/event-log.ts";

// Synthetic transcripts: only the SHAPES of a Claude Code transcript.
function assistant(id: string, input: number, output: number, meta: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: "assistant", ...meta, message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: input * 10, cache_creation_input_tokens: output * 10 } } })}\n`;
}

interface Env {
  kankakuDir: string;
  homeDir: string;
  projectDir: string;
  transcript: string;
  subagents: string;
  deps: HandleHookDeps;
  set: (t: number) => void;
}

function setup(): Env {
  const kankakuDir = mkdtempSync(join(tmpdir(), "kankaku-usage-"));
  const homeDir = mkdtempSync(join(tmpdir(), "kankaku-usage-home-"));
  const projectDir = mkdtempSync(join(tmpdir(), "kankaku-usage-proj-"));
  const transcript = join(projectDir, "session-1.jsonl");
  const subagents = join(projectDir, "session-1", "subagents");
  mkdirSync(subagents, { recursive: true });
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
  return { kankakuDir, homeDir, projectDir, transcript, subagents, deps, set: (t) => (current = t) };
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

function stateOf(env: Env) {
  return readState(resolvePaths({ env: env.deps.env, cwd: "/repo", sessionId: "session-1" }).stateFile);
}

test("UserPromptSubmit stores the transcript path and the current sizes of the main and subagent files, reading none of them", async () => {
  const env = setup();
  try {
    writeFileSync(env.transcript, assistant("old", 1000, 1000));
    writeFileSync(join(env.subagents, "agent-a.jsonl"), assistant("old-sub", 5, 5));
    writeFileSync(join(env.subagents, "agent-a.json"), "{}");
    // Unreadable content: only a stat can succeed.
    chmodSync(env.transcript, 0o000);
    chmodSync(join(env.subagents, "agent-a.jsonl"), 0o000);

    env.set(0);
    await handleHook(input(env, { hook_event_name: "SessionStart", source: "startup" }), env.deps);
    env.set(1000);
    await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt: "go" }), env.deps);

    const transcript = stateOf(env)?.transcript;
    assert.equal(transcript?.path, env.transcript);
    assert.deepEqual(transcript?.offsets, {
      [env.transcript]: { bytes: statSync(env.transcript).size },
      [join(env.subagents, "agent-a.jsonl")]: { bytes: statSync(join(env.subagents, "agent-a.jsonl")).size },
    });
    chmodSync(env.transcript, 0o600);
    chmodSync(join(env.subagents, "agent-a.jsonl"), 0o600);
  } finally {
    cleanup(env);
  }
});

test("hooks that build no record leave the transcript state alone and never touch the transcript", async () => {
  const env = setup();
  try {
    writeFileSync(env.transcript, assistant("m0", 1, 1));
    env.set(0);
    await handleHook(input(env, { hook_event_name: "SessionStart", source: "startup" }), env.deps);
    env.set(1000);
    await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt: "go" }), env.deps);
    const before = stateOf(env)?.transcript;
    assert.ok(before);

    // Now make the file unreadable and unstat-able: any access would surface as a change.
    rmSync(env.transcript);
    env.set(1100);
    await handleHook(input(env, { hook_event_name: "PreToolUse", tool_use_id: "t1", tool_name: "Read", tool_input: {} }), env.deps);
    await handleHook(input(env, { hook_event_name: "PermissionRequest", tool_use_id: "t2", tool_name: "Bash" }), env.deps);
    await handleHook(input(env, { hook_event_name: "PostToolUse", tool_use_id: "t1", tool_name: "Read" }), env.deps);
    await handleHook(input(env, { hook_event_name: "SubagentStart", agent_id: "a", agent_type: "x" }), env.deps);
    await handleHook(input(env, { hook_event_name: "SubagentStop", agent_id: "a", agent_type: "x" }), env.deps);
    assert.deepEqual(stateOf(env)?.transcript, before);
  } finally {
    cleanup(env);
  }
});

test("Stop stamps the tokens and the version, and the next prompt only counts what came after", async () => {
  const env = setup();
  try {
    writeFileSync(env.transcript, assistant("old", 999, 999, { version: "1.0.0" }));
    env.set(0);
    await handleHook(input(env, { hook_event_name: "SessionStart", source: "startup" }), env.deps);

    env.set(1000);
    await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt: "one" }), env.deps);
    appendFileSync(env.transcript, assistant("m1", 3, 4, { version: "2.5.0", entrypoint: "cli" }));
    appendFileSync(env.transcript, assistant("m1", 3, 4, { version: "2.5.0", entrypoint: "cli" }));
    writeFileSync(join(env.subagents, "agent-a.jsonl"), assistant("s1", 1, 2));
    env.set(2000);
    await handleHook(input(env, { hook_event_name: "Stop", stop_hook_active: false }), env.deps);

    // Tokens spent while no prompt is open belong to the next record.
    appendFileSync(env.transcript, assistant("gap", 100, 100));
    env.set(3000);
    await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt: "two" }), env.deps);
    appendFileSync(env.transcript, assistant("m2", 7, 8));
    appendFileSync(join(env.subagents, "agent-a.jsonl"), assistant("s2", 1, 1));
    writeFileSync(join(env.subagents, "agent-b.jsonl"), assistant("s3", 2, 2));
    env.set(4000);
    await handleHook(input(env, { hook_event_name: "Stop", stop_hook_active: false }), env.deps);

    const [one, two] = worklog(env);
    assert.equal(isWorkRecord(one), true);
    assert.deepEqual(one?.usage, { input: 4, output: 6, cacheRead: 40, cacheWrite: 60, cost: 0 });
    assert.equal(one?.agentVersion, "2.5.0");
    // Documented: the "gap" tokens are not lost, they land in the next settle.
    assert.deepEqual(two?.usage, { input: 110, output: 111, cacheRead: 1100, cacheWrite: 1110, cost: 0 });
    assert.equal(two?.agentVersion, "2.5.0");
    assert.equal(stateOf(env)?.transcript?.agentVersion, "2.5.0");
  } finally {
    cleanup(env);
  }
});

test("Stop keeps the statusline cost and adds the tokens to the same record", async () => {
  const env = setup();
  try {
    const { writeCost } = await import("../src/cost-store.ts");
    writeFileSync(env.transcript, "");
    env.set(0);
    await handleHook(input(env, { hook_event_name: "SessionStart", source: "startup" }), env.deps);
    env.set(1000);
    await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt: "go" }), env.deps);
    appendFileSync(env.transcript, assistant("m1", 2, 3, { version: "2.5.0", entrypoint: "cli" }));
    writeCost(env.deps.env, "session-1", { totalUsd: 0.5, updatedAt: 1500 });
    env.set(2000);
    await handleHook(input(env, { hook_event_name: "Stop", stop_hook_active: false }), env.deps);

    const [record] = worklog(env);
    assert.equal(record?.usage.cost, 0.5);
    assert.equal(record?.costObserved, true);
    assert.equal(record?.usage.input, 2);
    assert.equal(record?.usage.cacheWrite, 30);
  } finally {
    cleanup(env);
  }
});

test("a missing or unreadable transcript never stops the record: it is written without tokens or version", async () => {
  const env = setup();
  try {
    env.set(0);
    await handleHook(input(env, { hook_event_name: "SessionStart", source: "startup" }), env.deps);
    env.set(1000);
    // transcript_path points at a directory.
    await handleHook({ ...input(env, { hook_event_name: "UserPromptSubmit", prompt: "go" }), transcript_path: env.projectDir }, env.deps);
    env.set(2000);
    await handleHook(input(env, { hook_event_name: "Stop", stop_hook_active: false }), env.deps);

    // and a transcript_path that is not even a string
    env.set(3000);
    await handleHook({ ...input(env, { hook_event_name: "UserPromptSubmit", prompt: "two" }), transcript_path: 42 }, env.deps);
    env.set(4000);
    await handleHook(input(env, { hook_event_name: "Stop", stop_hook_active: false }), env.deps);

    const records = worklog(env);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(isWorkRecord(record), true);
      assert.deepEqual(record.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
      assert.equal(record.agentVersion, undefined);
    }
  } finally {
    cleanup(env);
  }
});

test("SessionEnd with an open prompt stamps the tokens of an interrupted record", async () => {
  const env = setup();
  try {
    writeFileSync(env.transcript, "");
    env.set(0);
    await handleHook(input(env, { hook_event_name: "SessionStart", source: "startup" }), env.deps);
    env.set(1000);
    await handleHook(input(env, { hook_event_name: "UserPromptSubmit", prompt: "go" }), env.deps);
    appendFileSync(env.transcript, assistant("m1", 6, 7, { version: "2.5.0", entrypoint: "cli" }));
    env.set(2000);
    await handleHook(input(env, { hook_event_name: "SessionEnd", reason: "exit" }), env.deps);

    const [record] = worklog(env);
    assert.equal(record?.status, "interrupted");
    assert.equal(record?.usage.input, 6);
    assert.equal(record?.usage.output, 7);
    assert.equal(record?.agentVersion, "2.5.0");
  } finally {
    cleanup(env);
  }
});

test("recovery of a dead session with an open prompt stamps the tokens and the version", () => {
  const env = setup();
  try {
    const claudeDir = join(env.kankakuDir, "claude");
    const stateFile = join(claudeDir, "dead.state.json");
    writeFileSync(env.transcript, assistant("old", 500, 500));
    const size = statSync(env.transcript).size;
    appendFileSync(env.transcript, assistant("m1", 9, 1, { version: "2.5.0", entrypoint: "cli" }));
    writeState(stateFile, {
      pid: 9999,
      parentPid: 1,
      cwd: "/repo",
      startedAt: 1,
      promptOpen: { id: "p", startedAt: 1000, costAtStart: undefined },
      permissionOpen: null,
      transcript: { path: env.transcript, offsets: { [env.transcript]: { bytes: size } } },
    });
    appendEvent(join(claudeDir, "dead.events.jsonl"), { ts: 1000, event: "UserPromptSubmit", prompt: "cut off" });

    const records = recoverStaleSessions({ claudeDir, currentSessionId: "other", isAlive: () => false, now: 5000, env: env.deps.env });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "interrupted");
    assert.equal(records[0]?.usage.input, 9);
    assert.equal(records[0]?.agentVersion, "2.5.0");
  } finally {
    cleanup(env);
  }
});
