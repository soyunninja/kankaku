import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTasks, buildTaskEntryCreatePayload, emptyUsage, WORK_RECORD_SCHEMA } from "kankaku-pi/domain";
import type { Client, HubTask, Project, WorkRecord, WorkRecordCore } from "kankaku-pi/domain";
import { handleHook, type HandleHookDeps } from "../src/handle-hook.ts";
import { recoverStaleSessions } from "../src/inflight-recovery.ts";
import { buildClaudeRecord } from "../src/record.ts";
import { writeState } from "../src/session-state.ts";
import { appendEvent } from "../src/event-log.ts";
import { writeSessionTarget } from "../src/session-target-store.ts";
import { runCli, type CliDeps } from "../src/cli-core.ts";
import { runDoctor } from "../src/doctor.ts";
import { formatTargetLine, formatTaskLine, resolveClaudeWorkTarget } from "../src/work-target.ts";

const HUB = "https://hub.example.test";
const CLIENTS: Client[] = [{ id: "c-acme", name: "Acme Corp", code: "acme", active: true }];
const PROJECTS: Project[] = [
  { id: "p-web", name: "Web", clientId: "c-acme", repoPaths: ["/work/acme/web"], active: true },
  { id: "p-api", name: "API", clientId: "c-acme", repoPaths: ["/work/acme/api"], active: true },
];
const TASKS: HubTask[] = [
  { id: "t-web", title: "Fix login", projectId: "p-web", status: "open" },
  { id: "t-api", title: "Ship endpoint", projectId: "p-api", status: "open" },
];
const WEB = "/work/acme/web";

interface F { dir: string; home: string; claudeDir: string; env: NodeJS.ProcessEnv; link: (session: string, taskId: string, title: string) => void; cleanup: () => void }

function fixture(tasks: HubTask[] = TASKS): F {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-link-dir-"));
  const home = mkdtempSync(join(tmpdir(), "kankaku-claude-link-home-"));
  mkdirSync(join(home, ".kankaku"), { recursive: true });
  writeFileSync(join(home, ".kankaku", "credentials.json"), JSON.stringify({ url: HUB, email: "a@b.c", password: "pw" }));
  writeFileSync(join(home, ".kankaku", "catalog.json"), JSON.stringify({ fetchedAt: 1, url: HUB, clients: CLIENTS, projects: PROJECTS, tasks }));
  const claudeDir = join(dir, "claude");
  return {
    dir, home, claudeDir, env: { KANKAKU_DIR: dir, HOME: home, KANKAKU_SYNC_AUTO: "0" },
    link: (session, taskId, title) => writeSessionTarget(join(claudeDir, `${session}.target.json`), { hubTaskId: taskId, hubTaskTitle: title, projectId: "p-web", pickedAt: 1, lastList: [] }),
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); },
  };
}

const resolve = (f: F, cwd: string, taskLink?: { hubTaskId: string; hubTaskTitle?: string }) =>
  resolveClaudeWorkTarget({ cwd, kankakuDir: f.dir, homeDir: f.home, env: f.env, ...(taskLink ? { taskLink } : {}) });

test("a link to a task of the resolved project is stamped on the target, and the source stays repo_paths", () => {
  const f = fixture();
  try {
    const r = resolve(f, WEB, { hubTaskId: "t-web", hubTaskTitle: "Fix login" });
    assert.equal(r.target?.hubTaskId, "t-web");
    assert.equal(r.target?.hubTaskTitle, "Fix login");
    assert.equal(r.target?.projectId, "p-web");
    assert.equal(r.source, "repoPaths");
    assert.equal(r.droppedTask, undefined);
    assert.equal(formatTaskLine(r), "task: Fix login");
    // the target line does not repeat the task
    assert.equal(formatTargetLine(r), "target: Acme Corp · Web (source: repo_paths)");
  } finally { f.cleanup(); }
});

test("the catalog's title wins over the stored one", () => {
  const f = fixture();
  try {
    assert.equal(resolve(f, WEB, { hubTaskId: "t-web", hubTaskTitle: "stale" }).target?.hubTaskTitle, "Fix login");
  } finally { f.cleanup(); }
});

test("a task of another project is dropped, never linked across projects", () => {
  const f = fixture();
  try {
    const r = resolve(f, WEB, { hubTaskId: "t-api", hubTaskTitle: "Ship endpoint" });
    assert.equal(r.target?.hubTaskId, undefined);
    assert.equal(r.target?.projectId, "p-web");
    assert.deepEqual(r.droppedTask, { title: "Ship endpoint" });
    assert.equal(formatTaskLine(r), 'task: none (linked task "Ship endpoint" is not in project Web)');
  } finally { f.cleanup(); }
});

test("a task gone from the catalog is dropped", () => {
  const f = fixture([TASKS[1]!]);
  try {
    const r = resolve(f, WEB, { hubTaskId: "t-web", hubTaskTitle: "Fix login" });
    assert.equal(r.target?.hubTaskId, undefined);
    assert.equal(formatTaskLine(r), 'task: none (linked task "Fix login" is not in project Web)');
  } finally { f.cleanup(); }
});

test("a link with a target that has no project, or no target at all, is dropped", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "config.json"), JSON.stringify({ clientId: "c-acme" }));
    const clientOnly = resolve(f, "/elsewhere", { hubTaskId: "t-web", hubTaskTitle: "Fix login" });
    assert.equal(clientOnly.target?.hubTaskId, undefined);
    assert.equal(formatTaskLine(clientOnly), 'task: none (linked task "Fix login" needs a project)');
    rmSync(join(f.dir, "config.json"));
    const none = resolve(f, "/elsewhere", { hubTaskId: "t-web", hubTaskTitle: "Fix login" });
    assert.equal(none.target, undefined);
    assert.equal(formatTaskLine(none), 'task: none (linked task "Fix login" needs a project)');
  } finally { f.cleanup(); }
});

test("without a link the task line is 'task: none' and nothing is reported dropped", () => {
  const f = fixture();
  try {
    const r = resolve(f, WEB);
    assert.equal(r.droppedTask, undefined);
    assert.equal(formatTaskLine(r), "task: none");
  } finally { f.cleanup(); }
});

const CORE: WorkRecordCore = {
  schema: WORK_RECORD_SCHEMA, id: "id-1", prompt: "p", startedAt: new Date(1000).toISOString(), settledAt: new Date(2000).toISOString(),
  wallMs: 1000, waitingMs: 0, workMs: 1000, runs: 1, turns: 1, tools: {}, subagents: [], usage: emptyUsage(), status: "completed",
};
const STATE = { pid: 1, parentPid: 2, cwd: WEB, startedAt: 1, promptOpen: null, permissionOpen: null };

test("buildClaudeRecord stamps hubTaskId and hubTaskTitle only when the target carries them", () => {
  const f = fixture();
  try {
    const linked = buildClaudeRecord(CORE, STATE, "s1", undefined, resolve(f, WEB, { hubTaskId: "t-web", hubTaskTitle: "Fix login" }));
    assert.equal(linked.hubTaskId, "t-web");
    assert.equal(linked.hubTaskTitle, "Fix login");
    const plain = buildClaudeRecord(CORE, STATE, "s1", undefined, resolve(f, WEB));
    assert.equal("hubTaskId" in plain, false);
    assert.equal("hubTaskTitle" in plain, false);
  } finally { f.cleanup(); }
});

test("outcome: a linked record reaches the hub payload with that task id, and a dropped link does not", () => {
  const f = fixture();
  try {
    const opts = { clients: CLIENTS, projects: PROJECTS, tasks: TASKS, machine: "m", promptMode: "none" as const, agent: "claude-code", plugin: "kankaku-claude" };
    const linked = buildClaudeRecord(CORE, STATE, "s1", undefined, resolve(f, WEB, { hubTaskId: "t-web", hubTaskTitle: "Fix login" }));
    const payload = buildTaskEntryCreatePayload(buildTasks([linked])[0]!, opts);
    assert.equal(payload.task, "t-web");
    assert.equal(payload.project, "p-web");
    const dropped = buildClaudeRecord(CORE, STATE, "s1", undefined, resolve(f, WEB, { hubTaskId: "t-api", hubTaskTitle: "Ship endpoint" }));
    assert.equal(buildTaskEntryCreatePayload(buildTasks([dropped])[0]!, opts).task, "");
  } finally { f.cleanup(); }
});

// ---- hooks -------------------------------------------------------------

function hookDeps(f: F, overrides: Partial<HandleHookDeps> = {}): { deps: HandleHookDeps; set: (t: number) => void } {
  let now = 0;
  return {
    set: (t) => { now = t; },
    deps: { env: f.env, now: () => now, sleep: async (ms) => { now += ms; }, isAlive: () => true, runPs: () => ({ ppid: 42, comm: "claude" }), stderr: () => {}, ...overrides },
  };
}
const ev = (cwd: string, over: Record<string, unknown>) => ({ session_id: "s1", cwd, ...over });
const records = (f: F): WorkRecord[] => {
  const file = join(f.dir, "worklog.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as WorkRecord) : [];
};

async function onePrompt(f: F, end: "Stop" | "SessionEnd", overrides: Partial<HandleHookDeps> = {}): Promise<void> {
  const { deps, set } = hookDeps(f, overrides);
  set(0);
  await handleHook(ev(WEB, { hook_event_name: "SessionStart", source: "startup" }), deps);
  set(1000);
  await handleHook(ev(WEB, { hook_event_name: "UserPromptSubmit", prompt: "work" }), deps);
  set(3000);
  await handleHook(ev(WEB, end === "Stop" ? { hook_event_name: "Stop", stop_hook_active: false } : { hook_event_name: "SessionEnd", reason: "other" }), deps);
}

test("Stop stamps the session's linked task on the record", async () => {
  const f = fixture();
  try {
    f.link("s1", "t-web", "Fix login");
    await onePrompt(f, "Stop");
    const [record] = records(f);
    assert.equal(record?.hubTaskId, "t-web");
    assert.equal(record?.hubTaskTitle, "Fix login");
    assert.equal(record?.projectId, "p-web");
  } finally { f.cleanup(); }
});

test("SessionEnd with an open prompt stamps it too, and deletes the link file", async () => {
  const f = fixture();
  try {
    f.link("s1", "t-web", "Fix login");
    await onePrompt(f, "SessionEnd");
    assert.equal(records(f)[0]?.hubTaskId, "t-web");
    assert.equal(existsSync(join(f.claudeDir, "s1.target.json")), false);
  } finally { f.cleanup(); }
});

test("a link to another project's task is dropped and the record carries no task", async () => {
  const f = fixture();
  try {
    f.link("s1", "t-api", "Ship endpoint");
    await onePrompt(f, "Stop");
    const [record] = records(f);
    assert.equal(record?.hubTaskId, undefined);
    assert.equal(record?.projectId, "p-web");
  } finally { f.cleanup(); }
});

test("a malformed link file is ignored", async () => {
  const f = fixture();
  try {
    mkdirSync(f.claudeDir, { recursive: true });
    writeFileSync(join(f.claudeDir, "s1.target.json"), "{oops");
    await onePrompt(f, "Stop");
    assert.equal(records(f)[0]?.hubTaskId, undefined);
    assert.equal(records(f).length, 1);
  } finally { f.cleanup(); }
});

test("the heavy path hands the resolver the session's link; the light path never touches it", async () => {
  const f = fixture();
  try {
    f.link("s1", "t-web", "Fix login");
    const seen: unknown[] = [];
    const { deps, set } = hookDeps(f, { resolveTarget: (input) => { seen.push(input.taskLink); return {}; } });
    set(0);
    await handleHook(ev(WEB, { hook_event_name: "UserPromptSubmit", prompt: "work" }), deps);
    await handleHook(ev(WEB, { hook_event_name: "PreToolUse", tool_use_id: "t1", tool_name: "Read", tool_input: {} }), deps);
    await handleHook(ev(WEB, { hook_event_name: "PostToolUse", tool_use_id: "t1", tool_name: "Read" }), deps);
    assert.deepEqual(seen, []);
    set(3000);
    await handleHook(ev(WEB, { hook_event_name: "Stop", stop_hook_active: false }), deps);
    assert.deepEqual(seen, [{ hubTaskId: "t-web", hubTaskTitle: "Fix login" }]);
  } finally { f.cleanup(); }
});

test("no link file: the resolver gets no taskLink", async () => {
  const f = fixture();
  try {
    const seen: unknown[] = [];
    const { deps, set } = hookDeps(f, { resolveTarget: (input) => { seen.push("taskLink" in input); return {}; } });
    set(0);
    await handleHook(ev(WEB, { hook_event_name: "UserPromptSubmit", prompt: "work" }), deps);
    set(3000);
    await handleHook(ev(WEB, { hook_event_name: "Stop", stop_hook_active: false }), deps);
    assert.deepEqual(seen, [false]);
  } finally { f.cleanup(); }
});

test("recovery resolves each dead session with its own link, then removes the link file", () => {
  const f = fixture();
  try {
    writeState(join(f.claudeDir, "dead.state.json"), { pid: 9999, parentPid: 1, cwd: WEB, startedAt: 1000, promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined }, permissionOpen: null });
    appendEvent(join(f.claudeDir, "dead.events.jsonl"), { ts: 1000, event: "UserPromptSubmit", prompt: "cut off" });
    f.link("dead", "t-web", "Fix login");
    const seen: string[] = [];
    const [record] = recoverStaleSessions({
      claudeDir: f.claudeDir, currentSessionId: "current", isAlive: () => false, now: 5000, env: { HOME: f.home },
      resolveAssignment: (cwd, sessionId) => { seen.push(`${cwd}|${sessionId}`); return { target: resolve(f, cwd, { hubTaskId: "t-web", hubTaskTitle: "Fix login" }).target! }; },
    });
    assert.deepEqual(seen, [`${WEB}|dead`]);
    assert.equal(record?.hubTaskId, "t-web");
    assert.equal(existsSync(join(f.claudeDir, "dead.target.json")), false);
  } finally { f.cleanup(); }
});

test("SessionStart recovery of a dead session stamps its linked task end to end", async () => {
  const f = fixture();
  try {
    writeState(join(f.claudeDir, "dead.state.json"), { pid: 9999, parentPid: 1, cwd: WEB, startedAt: 1000, promptOpen: { id: "p1", startedAt: 1000, costAtStart: undefined }, permissionOpen: null });
    appendEvent(join(f.claudeDir, "dead.events.jsonl"), { ts: 1000, event: "UserPromptSubmit", prompt: "cut off" });
    f.link("dead", "t-web", "Fix login");
    const { deps, set } = hookDeps(f, { isAlive: () => false });
    set(5000);
    await handleHook(ev("/elsewhere", { session_id: "current", hook_event_name: "SessionStart", source: "startup" }), deps);
    assert.equal(records(f).find((r) => r.sessionId === "dead")?.hubTaskId, "t-web");
    assert.equal(existsSync(join(f.claudeDir, "dead.target.json")), false);
  } finally { f.cleanup(); }
});

test("static: the link store is not reachable from the light hook path", () => {
  const seen = new Set<string>();
  const queue = [join(import.meta.dirname, "..", "src", "hook.ts")];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("import") || trimmed.startsWith("import type")) continue;
      const m = /from\s+"(\.\.?\/[^"]+)"/.exec(trimmed);
      if (m) queue.push(join(file, "..", m[1]!));
    }
  }
  assert.ok([...seen].some((file) => file.endsWith("handle-hook.ts")));
  assert.equal([...seen].some((file) => file.endsWith("session-target-store.ts")), false);
});

// ---- status / doctor ---------------------------------------------------

function cliDeps(f: F, session?: string): CliDeps {
  return { env: { ...f.env, ...(session ? { KANKAKU_CLAUDE_SESSION: session } : {}) }, cwd: WEB, now: () => 0, isAlive: () => true, pluginRoot: f.dir };
}

test("status and doctor show the linked task of this session", async () => {
  const f = fixture();
  try {
    f.link("s1", "t-web", "Fix login");
    const status = await runCli(["status"], cliDeps(f, "s1"));
    assert.match(status.stdout, /^target: Acme Corp · Web \(source: repo_paths\)\ntask: Fix login\n/);
    assert.match(runDoctor(cliDeps(f, "s1")), /## Work target\ntarget: Acme Corp · Web \(source: repo_paths\)\ntask: Fix login\n/);
  } finally { f.cleanup(); }
});

test("status and doctor say 'task: none' with no session or no link", async () => {
  const f = fixture();
  try {
    assert.match((await runCli(["status"], cliDeps(f))).stdout, /^target: [^\n]*\ntask: none\n/);
    assert.match((await runCli(["status"], cliDeps(f, "s1"))).stdout, /\ntask: none\n/);
    assert.match(runDoctor(cliDeps(f)), /## Work target\ntarget: [^\n]*\ntask: none\n/);
  } finally { f.cleanup(); }
});

test("status and doctor say why a stored link was dropped", async () => {
  const f = fixture();
  try {
    f.link("s1", "t-api", "Ship endpoint");
    const expected = 'task: none (linked task "Ship endpoint" is not in project Web)';
    assert.ok((await runCli(["status"], cliDeps(f, "s1"))).stdout.includes(`\n${expected}\n`));
    assert.ok(runDoctor(cliDeps(f, "s1")).includes(`\n${expected}\n`));
  } finally { f.cleanup(); }
});

test("doctor counts the task command file", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, "commands"));
    writeFileSync(join(f.dir, "commands", "task.md"), "---\n---\n");
    assert.match(runDoctor(cliDeps(f)), /command files present: 1\/8/);
  } finally { f.cleanup(); }
});
