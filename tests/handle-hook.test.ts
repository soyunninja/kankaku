import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isWorkRecord } from "kankaku/domain";
import type { WorkRecord } from "kankaku/domain";
import { handleHook, type HandleHookDeps } from "../src/handle-hook.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-claude-hook-"));
}

function readWorklog(kankakuDir: string): WorkRecord[] {
  const file = join(kankakuDir, "worklog.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as WorkRecord);
}

interface TestClock {
  now: () => number;
  set: (t: number) => void;
}

function makeClock(): TestClock {
  let current = 0;
  return {
    now: () => current,
    set: (t: number) => {
      current = t;
    },
  };
}

function makeDeps(kankakuDir: string, clock: TestClock, overrides: Partial<HandleHookDeps> = {}): HandleHookDeps {
  return {
    env: { KANKAKU_DIR: kankakuDir },
    now: clock.now,
    sleep: async (ms) => {
      clock.set(clock.now() + ms);
    },
    isAlive: () => true,
    runPs: () => ({ ppid: 42, comm: "claude" }),
    stderr: () => {},
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: "session-1",
    cwd: "/repo",
    ...overrides,
  };
}

test("static check: src/hook.ts and src/handle-hook.ts have no top-level runtime import from kankaku", () => {
  for (const file of ["hook.ts", "handle-hook.ts"]) {
    const text = readFileSync(join(__dirname, "..", "src", file), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("import")) continue;
      if (trimmed.startsWith("import type")) continue; // erased at runtime, not a real import
      assert.equal(
        /from\s+"kankaku/.test(trimmed),
        false,
        `${file} has a top-level runtime import from kankaku: ${trimmed}`,
      );
    }
  }
});

test("full prompt lifecycle: one completed record with a cost delta from a simulated statusline write", async () => {
  const kankakuDir = makeTmpDir();
  const clock = makeClock();
  const deps = makeDeps(kankakuDir, clock);
  const { mergeCost } = await import("../src/session-state.ts");
  const { resolvePaths } = await import("../src/paths.ts");
  try {
    clock.set(0);
    await handleHook(baseInput({ hook_event_name: "SessionStart", source: "startup" }), deps);

    const paths = resolvePaths({ env: deps.env, cwd: "/repo", sessionId: "session-1" });
    mergeCost(paths.stateFile, { totalUsd: 0.1, updatedAt: 200 }); // pre-existing baseline

    clock.set(1000);
    await handleHook(baseInput({ hook_event_name: "UserPromptSubmit", prompt: "do the thing" }), deps);

    clock.set(2000);
    await handleHook(
      baseInput({ hook_event_name: "PreToolUse", tool_use_id: "t1", tool_name: "Read", tool_input: { path: "/x" } }),
      deps,
    );
    clock.set(2500);
    await handleHook(baseInput({ hook_event_name: "PostToolUse", tool_use_id: "t1", tool_name: "Read" }), deps);

    clock.set(3000);
    await handleHook(baseInput({ hook_event_name: "PermissionRequest", tool_use_id: "t2", tool_name: "Bash" }), deps);
    clock.set(3500);
    await handleHook(
      baseInput({ hook_event_name: "PreToolUse", tool_use_id: "t2", tool_name: "Bash", tool_input: { command: "ls" } }),
      deps,
    );
    clock.set(4000);
    await handleHook(baseInput({ hook_event_name: "PostToolUse", tool_use_id: "t2", tool_name: "Bash" }), deps);

    // Simulate the statusline writing a fresher cost between the last tool and Stop.
    mergeCost(paths.stateFile, { totalUsd: 0.4, updatedAt: 4500 });

    clock.set(5000);
    await handleHook(baseInput({ hook_event_name: "Stop", stop_hook_active: false }), deps);

    const records = readWorklog(kankakuDir);
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(isWorkRecord(record), true);
    assert.equal(record.status, "completed");
    assert.equal(record.wallMs, record.waitingMs + record.workMs);
    assert.equal(record.wallMs, 4000);
    assert.equal(record.waitingMs, 500);
    assert.equal(record.tools.Read, 1);
    assert.equal(record.tools.Bash, 1);
    assert.ok(Math.abs(record.usage.cost - 0.3) < 1e-9);
    assert.equal(record.costObserved, true);
    assert.equal(record.sessionId, "session-1");
    assert.equal(record.project, "/repo");

    // The events file dropped the settled prompt (the leading SessionStart
    // line, not part of any prompt group, is harmlessly kept).
    const { readEventLog } = await import("../src/event-log.ts");
    assert.deepEqual(
      readEventLog(paths.eventsFile).map((e) => e.event),
      ["SessionStart"],
    );

    // promptOpen cleared.
    const { readState } = await import("../src/session-state.ts");
    assert.equal(readState(paths.stateFile)?.promptOpen, null);
  } finally {
    rmSync(kankakuDir, { recursive: true, force: true });
  }
});

test("a completed prompt with no cost write never gets costObserved", async () => {
  const kankakuDir = makeTmpDir();
  const clock = makeClock();
  const deps = makeDeps(kankakuDir, clock);
  try {
    clock.set(0);
    await handleHook(baseInput({ hook_event_name: "SessionStart", source: "startup" }), deps);
    clock.set(1000);
    await handleHook(baseInput({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), deps);
    clock.set(2000);
    await handleHook(baseInput({ hook_event_name: "Stop", stop_hook_active: false }), deps);

    const records = readWorklog(kankakuDir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.costObserved, undefined);
  } finally {
    rmSync(kankakuDir, { recursive: true, force: true });
  }
});

test("SessionStart recovers a dead session's open prompt as interrupted and cleans its files", async () => {
  const kankakuDir = makeTmpDir();
  const clock = makeClock();
  const { writeState } = await import("../src/session-state.ts");
  const { appendEvent } = await import("../src/event-log.ts");
  const { resolvePaths } = await import("../src/paths.ts");
  try {
    const deadPaths = resolvePaths({ env: { KANKAKU_DIR: kankakuDir }, cwd: "/repo", sessionId: "dead-session" });
    writeState(deadPaths.stateFile, {
      pid: 424242,
      parentPid: 1,
      cwd: "/repo",
      startedAt: 100,
      promptOpen: { id: "p1", startedAt: 100, costAtStart: undefined },
      cost: null,
      permissionOpen: null,
    });
    appendEvent(deadPaths.eventsFile, { ts: 100, event: "UserPromptSubmit", prompt: "cut off" });
    appendEvent(deadPaths.eventsFile, { ts: 200, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} });

    const deps = makeDeps(kankakuDir, clock, { isAlive: (pid) => pid !== 424242 });
    clock.set(5000);
    await handleHook(baseInput({ hook_event_name: "SessionStart", source: "startup" }), deps);

    const records = readWorklog(kankakuDir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "interrupted");
    assert.equal(records[0]?.sessionId, "dead-session");
    assert.equal(existsSync(deadPaths.stateFile), false);
    assert.equal(existsSync(deadPaths.eventsFile), false);

    const newPaths = resolvePaths({ env: { KANKAKU_DIR: kankakuDir }, cwd: "/repo", sessionId: "session-1" });
    assert.equal(existsSync(newPaths.stateFile), true);
  } finally {
    rmSync(kankakuDir, { recursive: true, force: true });
  }
});

test("SessionEnd with an open prompt appends an interrupted record and deletes this session's files", async () => {
  const kankakuDir = makeTmpDir();
  const clock = makeClock();
  const deps = makeDeps(kankakuDir, clock);
  const { resolvePaths } = await import("../src/paths.ts");
  try {
    clock.set(0);
    await handleHook(baseInput({ hook_event_name: "SessionStart", source: "startup" }), deps);
    clock.set(1000);
    await handleHook(baseInput({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), deps);
    clock.set(1500);
    await handleHook(
      baseInput({ hook_event_name: "PreToolUse", tool_use_id: "t1", tool_name: "Read", tool_input: {} }),
      deps,
    );

    clock.set(2000);
    await handleHook(baseInput({ hook_event_name: "SessionEnd", reason: "exit" }), deps);

    const records = readWorklog(kankakuDir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "interrupted");

    const paths = resolvePaths({ env: { KANKAKU_DIR: kankakuDir }, cwd: "/repo", sessionId: "session-1" });
    assert.equal(existsSync(paths.stateFile), false);
    assert.equal(existsSync(paths.eventsFile), false);
  } finally {
    rmSync(kankakuDir, { recursive: true, force: true });
  }
});
