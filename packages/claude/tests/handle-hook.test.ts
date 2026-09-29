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

interface TestDirs {
  kankakuDir: string;
  homeDir: string;
}

function makeDirs(): TestDirs {
  return { kankakuDir: makeTmpDir(), homeDir: mkdtempSync(join(tmpdir(), "kankaku-claude-hook-home-")) };
}

function cleanupDirs(dirs: TestDirs): void {
  rmSync(dirs.kankakuDir, { recursive: true, force: true });
  rmSync(dirs.homeDir, { recursive: true, force: true });
}

function makeDeps(dirs: TestDirs, clock: TestClock, overrides: Partial<HandleHookDeps> = {}): HandleHookDeps {
  return {
    env: { KANKAKU_DIR: dirs.kankakuDir, HOME: dirs.homeDir },
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

/**
 * Every module statically reachable from `src/hook.ts` through relative
 * `import ... from "./x.ts"` lines. `import type` lines are erased by Node's
 * type stripping and dynamic `import()` calls only run on the heavy paths
 * (Stop/SessionStart/SessionEnd), so neither is followed.
 */
function lightPathModules(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("import") || trimmed.startsWith("import type")) continue;
      const match = /from\s+"(\.\.?\/[^"]+)"/.exec(trimmed);
      if (match) queue.push(join(file, "..", match[1]!));
    }
  }
  return [...seen];
}

function assertClaudeIdentity(record: { agent?: string; agentVersion?: string; plugin?: string; pluginVersion?: string } | undefined): void {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(record?.agent, "claude-code");
  assert.equal(record?.plugin, "kankaku-claude");
  assert.equal(record?.pluginVersion, pkg.version);
  assert.equal(record?.agentVersion, undefined);
}

test("static check: nothing on the light hook path (src/hook.ts and its transitive relative imports) has a top-level runtime import from kankaku", () => {
  const modules = lightPathModules(join(__dirname, "..", "src", "hook.ts"));
  assert.ok(modules.some((file) => file.endsWith("handle-hook.ts")), "the walk must reach handle-hook.ts");
  assert.ok(modules.some((file) => file.endsWith("cost-store.ts")), "the walk must reach cost-store.ts");
  for (const file of modules) {
    const text = readFileSync(file, "utf8");
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
  const dirs = makeDirs();
  const clock = makeClock();
  const deps = makeDeps(dirs, clock);
  const { writeCost } = await import("../src/cost-store.ts");
  const { resolvePaths } = await import("../src/paths.ts");
  try {
    clock.set(0);
    await handleHook(baseInput({ hook_event_name: "SessionStart", source: "startup" }), deps);

    const paths = resolvePaths({ env: deps.env, cwd: "/repo", sessionId: "session-1" });
    writeCost(deps.env, "session-1", { totalUsd: 0.1, updatedAt: 200 }); // pre-existing baseline

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
    writeCost(deps.env, "session-1", { totalUsd: 0.4, updatedAt: 4500, model: "claude-opus-4" });

    clock.set(5000);
    await handleHook(baseInput({ hook_event_name: "Stop", stop_hook_active: false }), deps);

    const records = readWorklog(dirs.kankakuDir);
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(isWorkRecord(record), true);
    assert.equal(record.status, "completed");
    assertClaudeIdentity(record);
    assert.equal(record.wallMs, record.waitingMs + record.workMs);
    assert.equal(record.wallMs, 4000);
    assert.equal(record.waitingMs, 500);
    assert.equal(record.tools.Read, 1);
    assert.equal(record.tools.Bash, 1);
    // 0.4 - 0.1 is 0.30000000000000004 in binary floating point; the delta is
    // rounded to micro-dollars so the persisted record carries no such noise.
    assert.equal(record.usage.cost, 0.3);
    assert.equal(record.costObserved, true);
    assert.equal(record.sessionId, "session-1");
    assert.equal(record.project, "/repo");
    assert.equal(record.model, "anthropic/claude-opus-4");

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

    // Nothing but the project's own events/state files landed under the project.
    assert.equal(existsSync(join(dirs.kankakuDir, "claude", "cost")), false);
  } finally {
    cleanupDirs(dirs);
  }
});

test("heavy hooks sync after local writes and clean up even when sync rejects", async () => {
  const dirs = makeDirs();
  const clock = makeClock();
  const calls: Array<{ trigger: string; records: number }> = [];
  const errors: string[] = [];
  const deps = makeDeps(dirs, clock, {
    autoSync: async (trigger) => {
      calls.push({ trigger, records: readWorklog(dirs.kankakuDir).length });
      if (trigger !== "session_start") throw new Error("offline");
    },
    stderr: (message) => errors.push(message),
  });
  const { resolvePaths } = await import("../src/paths.ts");
  try {
    await handleHook(baseInput({ hook_event_name: "SessionStart" }), deps);
    clock.set(1000);
    await handleHook(baseInput({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), deps);
    clock.set(2000);
    await handleHook(baseInput({ hook_event_name: "Stop" }), deps);
    assert.equal(readWorklog(dirs.kankakuDir).length, 1);
    const paths = resolvePaths({ env: deps.env, cwd: "/repo", sessionId: "session-1" });
    const { readState } = await import("../src/session-state.ts");
    assert.equal(readState(paths.stateFile)?.promptOpen, null);
    clock.set(3000);
    await handleHook(baseInput({ hook_event_name: "SessionEnd" }), deps);
    assert.deepEqual(calls, [
      { trigger: "session_start", records: 0 },
      { trigger: "agent_settled", records: 1 },
      { trigger: "session_shutdown", records: 1 },
    ]);
    assert.equal(existsSync(paths.stateFile), false);
    assert.equal(existsSync(paths.eventsFile), false);
    assert.equal(errors.length, 2);
  } finally { cleanupDirs(dirs); }
});

test("a completed prompt with no cost write never gets costObserved", async () => {
  const dirs = makeDirs();
  const clock = makeClock();
  const deps = makeDeps(dirs, clock);
  try {
    clock.set(0);
    await handleHook(baseInput({ hook_event_name: "SessionStart", source: "startup" }), deps);
    clock.set(1000);
    await handleHook(baseInput({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), deps);
    clock.set(2000);
    await handleHook(baseInput({ hook_event_name: "Stop", stop_hook_active: false }), deps);

    const records = readWorklog(dirs.kankakuDir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.costObserved, undefined);
  } finally {
    cleanupDirs(dirs);
  }
});

test("UserPromptSubmit sets promptOpen.costAtStart from the cost file, not the project state file", async () => {
  const dirs = makeDirs();
  const clock = makeClock();
  const deps = makeDeps(dirs, clock);
  const { writeCost } = await import("../src/cost-store.ts");
  const { resolvePaths } = await import("../src/paths.ts");
  const { readState } = await import("../src/session-state.ts");
  try {
    clock.set(0);
    await handleHook(baseInput({ hook_event_name: "SessionStart", source: "startup" }), deps);
    writeCost(deps.env, "session-1", { totalUsd: 0.25, updatedAt: 500 });

    clock.set(1000);
    await handleHook(baseInput({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), deps);

    const paths = resolvePaths({ env: deps.env, cwd: "/repo", sessionId: "session-1" });
    assert.equal(readState(paths.stateFile)?.promptOpen?.costAtStart, 0.25);
  } finally {
    cleanupDirs(dirs);
  }
});

test("SessionStart recovers a dead session's open prompt as interrupted and cleans its files", async () => {
  const dirs = makeDirs();
  const clock = makeClock();
  const { writeState } = await import("../src/session-state.ts");
  const { appendEvent } = await import("../src/event-log.ts");
  const { resolvePaths } = await import("../src/paths.ts");
  try {
    const deadPaths = resolvePaths({ env: { KANKAKU_DIR: dirs.kankakuDir }, cwd: "/repo", sessionId: "dead-session" });
    writeState(deadPaths.stateFile, {
      pid: 424242,
      parentPid: 1,
      cwd: "/repo",
      startedAt: 100,
      promptOpen: { id: "p1", startedAt: 100, costAtStart: undefined },
      permissionOpen: null,
    });
    appendEvent(deadPaths.eventsFile, { ts: 100, event: "UserPromptSubmit", prompt: "cut off" });
    appendEvent(deadPaths.eventsFile, { ts: 200, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} });

    const deps = makeDeps(dirs, clock, { isAlive: (pid) => pid !== 424242 });
    clock.set(5000);
    await handleHook(baseInput({ hook_event_name: "SessionStart", source: "startup" }), deps);

    const records = readWorklog(dirs.kankakuDir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "interrupted");
    assertClaudeIdentity(records[0]);
    assert.equal(records[0]?.sessionId, "dead-session");
    assert.equal(existsSync(deadPaths.stateFile), false);
    assert.equal(existsSync(deadPaths.eventsFile), false);

    const newPaths = resolvePaths({ env: { KANKAKU_DIR: dirs.kankakuDir }, cwd: "/repo", sessionId: "session-1" });
    assert.equal(existsSync(newPaths.stateFile), true);
  } finally {
    cleanupDirs(dirs);
  }
});

test("SessionStart (non-compact) sweeps cost files older than 7 days", async () => {
  const dirs = makeDirs();
  const clock = makeClock();
  const { writeCost, costFile } = await import("../src/cost-store.ts");
  try {
    writeCost({ HOME: dirs.homeDir }, "stale-session", { totalUsd: 1, updatedAt: 0 });
    const deps = makeDeps(dirs, clock);
    clock.set(8 * 24 * 60 * 60 * 1000); // 8 days later
    await handleHook(baseInput({ hook_event_name: "SessionStart", source: "startup" }), deps);

    assert.equal(existsSync(costFile({ HOME: dirs.homeDir }, "stale-session")), false);
  } finally {
    cleanupDirs(dirs);
  }
});

test("SessionStart with source compact does not sweep cost files", async () => {
  const dirs = makeDirs();
  const clock = makeClock();
  const { writeCost, costFile } = await import("../src/cost-store.ts");
  try {
    writeCost({ HOME: dirs.homeDir }, "stale-session", { totalUsd: 1, updatedAt: 0 });
    const deps = makeDeps(dirs, clock);
    clock.set(8 * 24 * 60 * 60 * 1000);
    await handleHook(baseInput({ hook_event_name: "SessionStart", source: "compact" }), deps);

    assert.equal(existsSync(costFile({ HOME: dirs.homeDir }, "stale-session")), true);
  } finally {
    cleanupDirs(dirs);
  }
});

test("SessionEnd with an open prompt appends an interrupted record and deletes this session's files, including its cost file", async () => {
  const dirs = makeDirs();
  const clock = makeClock();
  const seen: Array<{ trigger: string; status: string | undefined }> = [];
  const deps = makeDeps(dirs, clock, { autoSync: async (trigger) => {
    seen.push({ trigger, status: readWorklog(dirs.kankakuDir).at(-1)?.status });
  } });
  const { resolvePaths } = await import("../src/paths.ts");
  const { writeCost, costFile } = await import("../src/cost-store.ts");
  try {
    clock.set(0);
    await handleHook(baseInput({ hook_event_name: "SessionStart", source: "startup" }), deps);
    writeCost(deps.env, "session-1", { totalUsd: 0.1, updatedAt: 100, model: "claude-x" });
    clock.set(1000);
    await handleHook(baseInput({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), deps);
    clock.set(1500);
    await handleHook(
      baseInput({ hook_event_name: "PreToolUse", tool_use_id: "t1", tool_name: "Read", tool_input: {} }),
      deps,
    );

    clock.set(2000);
    await handleHook(baseInput({ hook_event_name: "SessionEnd", reason: "exit" }), deps);

    const records = readWorklog(dirs.kankakuDir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "interrupted");
    assertClaudeIdentity(records[0]);
    assert.equal(records[0]?.model, "anthropic/claude-x");
    assert.deepEqual(seen, [{ trigger: "session_start", status: undefined }, { trigger: "session_shutdown", status: "interrupted" }]);

    const paths = resolvePaths({ env: { KANKAKU_DIR: dirs.kankakuDir }, cwd: "/repo", sessionId: "session-1" });
    assert.equal(existsSync(paths.stateFile), false);
    assert.equal(existsSync(paths.eventsFile), false);
    assert.equal(existsSync(costFile(deps.env, "session-1")), false);
  } finally {
    cleanupDirs(dirs);
  }
});
