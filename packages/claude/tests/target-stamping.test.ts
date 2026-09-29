import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, Project, WorkRecord } from "kankaku/domain";
import { handleHook, type HandleHookDeps } from "../src/handle-hook.ts";
import { recoverStaleSessions } from "../src/inflight-recovery.ts";
import { writeState } from "../src/session-state.ts";
import { appendEvent } from "../src/event-log.ts";
import { writeSessionTarget } from "../src/session-target-store.ts";
import type { ClaudeWorkTarget } from "../src/work-target.ts";

const HUB = "https://hub.example.test";
const CLIENTS: Client[] = [
  { id: "c-unassigned", name: "Sin determinar", code: "SIN", active: true, unassigned: true },
  { id: "c-acme", name: "Acme Corp", code: "acme", active: true },
];
const PROJECTS: Project[] = [{ id: "p-web", name: "Web", clientId: "c-acme", repoPaths: ["/work/acme/web"], active: true }];

interface Dirs { kankakuDir: string; home: string }

function makeDirs(withCache = true): Dirs {
  const kankakuDir = mkdtempSync(join(tmpdir(), "kankaku-claude-stamp-dir-"));
  const home = mkdtempSync(join(tmpdir(), "kankaku-claude-stamp-home-"));
  mkdirSync(join(home, ".kankaku"), { recursive: true });
  if (withCache) {
    writeFileSync(join(home, ".kankaku", "credentials.json"), JSON.stringify({ url: HUB, email: "a@b.c", password: "pw" }));
    writeFileSync(join(home, ".kankaku", "catalog.json"), JSON.stringify({ fetchedAt: 1, url: HUB, clients: CLIENTS, projects: PROJECTS }));
  }
  return { kankakuDir, home };
}

function cleanup(d: Dirs): void {
  rmSync(d.kankakuDir, { recursive: true, force: true });
  rmSync(d.home, { recursive: true, force: true });
}

function makeDeps(d: Dirs, overrides: Partial<HandleHookDeps> = {}, extraEnv: NodeJS.ProcessEnv = {}): { deps: HandleHookDeps; set: (t: number) => void } {
  let now = 0;
  return {
    set: (t) => { now = t; },
    deps: {
      env: { KANKAKU_DIR: d.kankakuDir, HOME: d.home, KANKAKU_SYNC_AUTO: "0", ...extraEnv },
      now: () => now,
      sleep: async (ms) => { now += ms; },
      isAlive: () => true,
      runPs: () => ({ ppid: 42, comm: "claude" }),
      stderr: () => {},
      ...overrides,
    },
  };
}

function worklog(d: Dirs): WorkRecord[] {
  const file = join(d.kankakuDir, "worklog.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as WorkRecord);
}

function input(cwd: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return { session_id: "s1", cwd, ...overrides };
}

async function onePrompt(deps: HandleHookDeps, set: (t: number) => void, cwd: string, end: "Stop" | "SessionEnd"): Promise<void> {
  set(0);
  await handleHook(input(cwd, { hook_event_name: "SessionStart", source: "startup" }), deps);
  set(1000);
  await handleHook(input(cwd, { hook_event_name: "UserPromptSubmit", prompt: "work" }), deps);
  set(2000);
  await handleHook(input(cwd, { hook_event_name: "PreToolUse", tool_use_id: "t1", tool_name: "Read", tool_input: {} }), deps);
  set(2500);
  await handleHook(input(cwd, { hook_event_name: "PostToolUse", tool_use_id: "t1", tool_name: "Read" }), deps);
  set(3000);
  await handleHook(input(cwd, end === "Stop" ? { hook_event_name: "Stop", stop_hook_active: false } : { hook_event_name: "SessionEnd", reason: "other" }), deps);
}

test("Stop stamps the resolved target and the legacy client label on the record", async () => {
  const d = makeDirs();
  try {
    const { deps, set } = makeDeps(d);
    await onePrompt(deps, set, "/work/acme/web", "Stop");
    const [record] = worklog(d);
    assert.equal(record?.clientId, "c-acme");
    assert.equal(record?.clientName, "Acme Corp");
    assert.equal(record?.projectId, "p-web");
    assert.equal(record?.projectName, "Web");
    assert.equal(record?.client, "acme");
  } finally { cleanup(d); }
});

test("SessionEnd with an open prompt stamps the resolved target too", async () => {
  const d = makeDirs();
  try {
    const { deps, set } = makeDeps(d);
    set(0);
    await handleHook(input("/work/acme/web", { hook_event_name: "SessionStart", source: "startup" }), deps);
    set(1000);
    await handleHook(input("/work/acme/web", { hook_event_name: "UserPromptSubmit", prompt: "work" }), deps);
    set(2000);
    await handleHook(input("/work/acme/web", { hook_event_name: "SessionEnd", reason: "other" }), deps);
    const [record] = worklog(d);
    assert.equal(record?.status, "interrupted");
    assert.equal(record?.clientId, "c-acme");
    assert.equal(record?.projectId, "p-web");
  } finally { cleanup(d); }
});

test("without a catalog cache the record stays unassigned, and KANKAKU_CLIENT still becomes the legacy label", async () => {
  const d = makeDirs(false);
  try {
    const { deps, set } = makeDeps(d, {}, { KANKAKU_CLIENT: "from-env" });
    await onePrompt(deps, set, "/work/acme/web", "Stop");
    const [record] = worklog(d);
    assert.equal(record?.clientId, undefined);
    assert.equal(record?.projectId, undefined);
    assert.equal(record?.client, "from-env");
  } finally { cleanup(d); }
});

test("SessionStart recovery stamps the target resolved from the dead session's own cwd", async () => {
  const d = makeDirs();
  try {
    const claudeDir = join(d.kankakuDir, "claude");
    writeState(join(claudeDir, "dead.state.json"), { pid: 9999, parentPid: 1, cwd: "/work/acme/web", startedAt: 1000, promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined }, permissionOpen: null });
    appendEvent(join(claudeDir, "dead.events.jsonl"), { ts: 1000, event: "UserPromptSubmit", prompt: "cut off" });
    const { deps, set } = makeDeps(d, { isAlive: () => false });
    set(5000);
    await handleHook(input("/elsewhere", { session_id: "current", hook_event_name: "SessionStart", source: "startup" }), deps);
    const recovered = worklog(d).find((r) => r.sessionId === "dead");
    assert.equal(recovered?.status, "interrupted");
    assert.equal(recovered?.clientId, "c-acme");
    assert.equal(recovered?.projectId, "p-web");
  } finally { cleanup(d); }
});

test("recoverStaleSessions calls the assignment resolver with each session's cwd", () => {
  const d = makeDirs(false);
  try {
    const claudeDir = join(d.kankakuDir, "claude");
    writeState(join(claudeDir, "dead.state.json"), { pid: 9999, parentPid: 1, cwd: "/work/x", startedAt: 1000, promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined }, permissionOpen: null });
    appendEvent(join(claudeDir, "dead.events.jsonl"), { ts: 1000, event: "UserPromptSubmit", prompt: "cut off" });
    const seen: string[] = [];
    const [record] = recoverStaleSessions({
      claudeDir, currentSessionId: "current", isAlive: () => false, now: 5000, env: { HOME: d.home },
      resolveAssignment: (cwd) => { seen.push(cwd); return { legacyClient: "labelled" }; },
    });
    assert.deepEqual(seen, ["/work/x"]);
    assert.equal(record?.client, "labelled");
  } finally { cleanup(d); }
});

test("the light hook path never resolves a target; only Stop does", async () => {
  const d = makeDirs();
  try {
    let calls = 0;
    const links: unknown[] = [];
    const { deps, set } = makeDeps(d, { resolveTarget: (input): ClaudeWorkTarget => { calls++; links.push(input.taskLink); return {}; } });
    const cwd = "/work/acme/web";
    // A session link on disk: only the heavy path may read it.
    writeSessionTarget(join(d.kankakuDir, "claude", "s1.target.json"), { hubTaskId: "t1", hubTaskTitle: "Task", lastList: [] });
    set(0);
    await handleHook(input(cwd, { hook_event_name: "UserPromptSubmit", prompt: "work" }), deps);
    await handleHook(input(cwd, { hook_event_name: "PreToolUse", tool_use_id: "t1", tool_name: "Read", tool_input: {} }), deps);
    await handleHook(input(cwd, { hook_event_name: "PermissionRequest", tool_use_id: "t2", tool_name: "Bash" }), deps);
    await handleHook(input(cwd, { hook_event_name: "PostToolUse", tool_use_id: "t1", tool_name: "Read" }), deps);
    await handleHook(input(cwd, { hook_event_name: "SubagentStart", agent_id: "a", agent_type: "x" }), deps);
    await handleHook(input(cwd, { hook_event_name: "SubagentStop", agent_id: "a", agent_type: "x" }), deps);
    assert.equal(calls, 0);
    set(4000);
    await handleHook(input(cwd, { hook_event_name: "Stop", stop_hook_active: false }), deps);
    assert.equal(calls, 1);
    assert.deepEqual(links, [{ hubTaskId: "t1", hubTaskTitle: "Task" }]);
  } finally { cleanup(d); }
});

test("a throwing target resolver never breaks record writing", async () => {
  const d = makeDirs();
  try {
    const { deps, set } = makeDeps(d, { resolveTarget: () => { throw new Error("boom"); } });
    await onePrompt(deps, set, "/work/acme/web", "Stop");
    const [record] = worklog(d);
    assert.equal(record?.status, "completed");
    assert.equal(record?.clientId, undefined);
  } finally { cleanup(d); }
});
