import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, HubTask, Project } from "kankaku-pi/domain";
import type { CliDeps } from "../src/cli-core.ts";
import { runTaskCli } from "../src/task-cli.ts";
import { readSessionTarget, writeSessionTarget } from "../src/session-target-store.ts";
import { writeState } from "../src/session-state.ts";

const HUB = "https://hub.example.test";
const NOW = 10 * 3600_000;
const CLIENTS: Client[] = [{ id: "c-acme", name: "Acme Corp", code: "acme", active: true }];
const TASKS: HubTask[] = [
  { id: "t1", title: "Alpha login fix", projectId: "p-web", status: "open" },
  { id: "t2", title: "Beta login page", projectId: "p-web", status: "doing", externalRef: "WEB-2" },
  { id: "t3", title: "Zeta report", projectId: "p-web", status: "open" },
  { id: "t4", title: "Old thing", projectId: "p-web", status: "done" },
  { id: "x1", title: "Other project task", projectId: "p-api", status: "open" },
];

interface Fixture {
  dir: string; home: string; cwd: string; deps: CliDeps & { fetch: typeof fetch };
  session: () => string; target: (id?: string) => string; fetched: string[]; cleanup: () => void;
}

function fixture(opts: { tasks?: HubTask[]; cache?: boolean; fetchMode?: "ok" | "fail" | "hang"; session?: string | null; cwd?: string } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-task-dir-"));
  const home = mkdtempSync(join(tmpdir(), "kankaku-claude-task-home-"));
  const cwd = opts.cwd ?? "/work/acme/web";
  const projects: Project[] = [
    { id: "p-web", name: "Web", clientId: "c-acme", repoPaths: ["/work/acme/web"], active: true },
    { id: "p-api", name: "API", clientId: "c-acme", repoPaths: ["/work/acme/api"], active: true },
  ];
  const tasks = opts.tasks ?? TASKS;
  mkdirSync(join(home, ".kankaku"), { recursive: true });
  writeFileSync(join(home, ".kankaku", "credentials.json"), JSON.stringify({ url: HUB, email: "a@b.c", password: "pw" }));
  if (opts.cache !== false) {
    writeFileSync(join(home, ".kankaku", "catalog.json"), JSON.stringify({ fetchedAt: NOW - 2 * 3600_000, url: HUB, clients: CLIENTS, projects, tasks }));
  }
  const fetched: string[] = [];
  const mode = opts.fetchMode ?? "ok";
  const fetchStub: typeof fetch = async (input, init) => {
    const url = String(input);
    fetched.push(url);
    if (mode === "hang") return new Promise<Response>(() => {});
    if (mode === "fail") throw new Error("offline");
    if (url.includes("auth-with-password")) return Response.json({ token: "tk", record: { id: "u" } });
    void init;
    const items = url.includes("/collections/clients/") ? CLIENTS.map((c) => ({ ...c, active: c.active }))
      : url.includes("/collections/projects/") ? projects.map((p) => ({ id: p.id, name: p.name, client: p.clientId, repo_paths: p.repoPaths, active: p.active }))
      : tasks.map((t) => ({ id: t.id, title: t.title, project: t.projectId, status: t.status, ...(t.externalRef ? { external_ref: t.externalRef } : {}) }));
    return Response.json({ items, page: 1, perPage: 500, totalPages: 1, totalItems: items.length });
  };
  const session = opts.session === undefined ? "s1" : opts.session;
  const deps = {
    env: { KANKAKU_DIR: dir, HOME: home, ...(session ? { KANKAKU_CLAUDE_SESSION: session } : {}) },
    cwd, now: () => NOW, isAlive: () => true, pluginRoot: "/x", fetch: fetchStub, catalogTimeoutMs: 50,
  };
  return {
    dir, home, cwd, deps, fetched,
    session: () => session ?? "",
    target: (id = session ?? "") => join(dir, "claude", `${id}.target.json`),
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); },
  };
}

test("no session found: a clear message, exit 1, nothing written", async () => {
  const f = fixture({ session: null });
  try {
    const r = await runTaskCli([], f.deps);
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, "no active Claude Code session found for this folder\n");
    assert.equal(existsSync(join(f.dir, "claude")), false);
    assert.equal((await runTaskCli(["clear"], f.deps)).exitCode, 1);
    assert.equal((await runTaskCli(["1"], f.deps)).stdout, "no active Claude Code session found for this folder\n");
    assert.equal(existsSync(join(f.dir, "claude")), false);
  } finally { f.cleanup(); }
});

test("the session is found from the pid walk when no override is set", async () => {
  const f = fixture({ session: null });
  try {
    writeState(join(f.dir, "claude", "abc.state.json"), { pid: 300, parentPid: 1, cwd: f.cwd, startedAt: 1, promptOpen: null, permissionOpen: null });
    const runPs = (pid: number) => ({ 500: { ppid: 300, comm: "node" }, 300: { ppid: 1, comm: "claude" } } as Record<number, { ppid: number; comm: string }>)[pid];
    const r = await runTaskCli([], { ...f.deps, pid: 500, runPs });
    assert.equal(r.exitCode, 0);
    assert.ok(existsSync(f.target("abc")));
  } finally { f.cleanup(); }
});

test("list refreshes the catalog and prints the open tasks numbered, then the hint", async () => {
  const f = fixture();
  try {
    const r = await runTaskCli([], f.deps);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, [
      "open tasks in project Web:",
      "  1. Alpha login fix",
      "  2. Beta login page (WEB-2)",
      "  3. Zeta report",
      "pick one with: /kankaku:task <number>",
      "",
    ].join("\n"));
    assert.ok(f.fetched.some((u) => u.includes("/collections/tasks/")));
    assert.deepEqual(readSessionTarget(f.target())?.lastList, ["t1", "t2", "t3"]);
    assert.equal((await runTaskCli(["list"], f.deps)).stdout, r.stdout);
  } finally { f.cleanup(); }
});

test("list marks the linked task", async () => {
  const f = fixture();
  try {
    writeSessionTarget(f.target(), { hubTaskId: "t2", hubTaskTitle: "Beta login page", projectId: "p-web", pickedAt: 1, lastList: [] });
    const r = await runTaskCli([], f.deps);
    assert.match(r.stdout, /\n  1\. Alpha login fix\n\* 2\. Beta login page \(WEB-2\) \[linked\]\n/);
  } finally { f.cleanup(); }
});

test("an offline hub falls back to the cache and says how old it is", async () => {
  const f = fixture({ fetchMode: "fail" });
  try {
    const r = await runTaskCli([], f.deps);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /^catalog from cache, 2h old\nopen tasks in project Web:\n/);
  } finally { f.cleanup(); }
});

test("a hub that never answers is cut off by the time bound", async () => {
  const f = fixture({ fetchMode: "hang" });
  try {
    const started = Date.now();
    const r = await runTaskCli([], f.deps);
    assert.ok(Date.now() - started < 2000);
    assert.match(r.stdout, /^catalog from cache, 2h old\n/);
  } finally { f.cleanup(); }
});

test("no project resolved for the folder: message with the reason, exit 1", async () => {
  const f = fixture({ cwd: "/somewhere/else" });
  try {
    const r = await runTaskCli([], f.deps);
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, "no project resolved for this folder (no match for /somewhere/else); a task belongs to a project\n");
  } finally { f.cleanup(); }
});

test("no cache and an unreachable hub: no project resolved, exit 1", async () => {
  const f = fixture({ cache: false, fetchMode: "fail" });
  try {
    const r = await runTaskCli([], f.deps);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /^no project resolved for this folder \(no catalog cache\)/);
  } finally { f.cleanup(); }
});

test("a project with no open tasks says so, exit 0", async () => {
  const f = fixture({ tasks: [TASKS[3]!, TASKS[4]!] });
  try {
    const r = await runTaskCli([], f.deps);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "no open tasks in project Web\n");
  } finally { f.cleanup(); }
});

test("picking by number uses the last list shown, links the task and prints it", async () => {
  const f = fixture();
  try {
    await runTaskCli([], f.deps);
    const r = await runTaskCli(["3"], f.deps);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "linked: Zeta report\n");
    const stored = readSessionTarget(f.target());
    assert.equal(stored?.hubTaskId, "t3");
    assert.equal(stored?.hubTaskTitle, "Zeta report");
    assert.equal(stored?.projectId, "p-web");
    assert.equal(stored?.pickedAt, NOW);
    assert.deepEqual(stored?.lastList, ["t1", "t2", "t3"]);
  } finally { f.cleanup(); }
});

test("a number before any list was shown is refused and writes nothing", async () => {
  const f = fixture();
  try {
    const r = await runTaskCli(["1"], f.deps);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /list the tasks first/);
    assert.equal(readSessionTarget(f.target())?.hubTaskId, undefined);
  } finally { f.cleanup(); }
});

test("picking by hub id and by unique text", async () => {
  const f = fixture();
  try {
    assert.equal((await runTaskCli(["t1"], f.deps)).stdout, "linked: Alpha login fix\n");
    assert.equal((await runTaskCli(["zeta"], f.deps)).stdout, "linked: Zeta report\n");
    assert.equal(readSessionTarget(f.target())?.hubTaskId, "t3");
    // multi-word text arrives as several argv items
    assert.equal((await runTaskCli(["beta", "login"], f.deps)).stdout, "linked: Beta login page\n");
  } finally { f.cleanup(); }
});

test("ambiguous text prints numbered candidates, changes the link nothing and makes them pickable by number", async () => {
  const f = fixture();
  try {
    await runTaskCli(["t3"], f.deps);
    const r = await runTaskCli(["login"], f.deps);
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, [
      'several open tasks match "login":',
      "  1. Alpha login fix",
      "  2. Beta login page (WEB-2)",
      "pick one with: /kankaku:task <number>",
      "",
    ].join("\n"));
    const stored = readSessionTarget(f.target());
    assert.equal(stored?.hubTaskId, "t3");
    assert.deepEqual(stored?.lastList, ["t1", "t2"]);
    assert.equal((await runTaskCli(["2"], f.deps)).stdout, "linked: Beta login page\n");
  } finally { f.cleanup(); }
});

test("unknown text, another project's task and a done task are refused", async () => {
  const f = fixture();
  try {
    for (const arg of ["nothing-like-this", "x1", "t4", "Old thing"]) {
      const r = await runTaskCli([arg], f.deps);
      assert.equal(r.exitCode, 1, arg);
      assert.doesNotMatch(r.stdout, /^linked:/, arg);
    }
    assert.equal(existsSync(f.target()), false); // a refusal writes nothing
    assert.equal(readSessionTarget(f.target())?.hubTaskId, undefined);
  } finally { f.cleanup(); }
});

test("clear drops the link and keeps the list; without a link it says so", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await runTaskCli(["clear"], f.deps), { stdout: "no task linked\n", exitCode: 0 });
    await runTaskCli([], f.deps);
    await runTaskCli(["1"], f.deps);
    const r = await runTaskCli(["clear"], f.deps);
    assert.deepEqual(r, { stdout: "task link cleared\n", exitCode: 0 });
    const stored = readSessionTarget(f.target());
    assert.equal(stored?.hubTaskId, undefined);
    assert.deepEqual(stored?.lastList, ["t1", "t2", "t3"]);
    assert.equal((await runTaskCli(["clear"], f.deps)).stdout, "no task linked\n");
  } finally { f.cleanup(); }
});

test("clear needs no project and no network", async () => {
  const f = fixture({ cwd: "/somewhere/else", fetchMode: "fail" });
  try {
    writeSessionTarget(f.target(), { hubTaskId: "t1", hubTaskTitle: "x", projectId: "p", pickedAt: 1, lastList: [] });
    assert.equal((await runTaskCli(["clear"], f.deps)).stdout, "task link cleared\n");
    assert.deepEqual(f.fetched, []);
  } finally { f.cleanup(); }
});
