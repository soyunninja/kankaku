import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, HubTask, Project } from "kankaku-pi/domain";
import { runCli, type CliDeps } from "../src/cli-core.ts";
import { runTargetCli } from "../src/target-cli.ts";
import { readSessionTarget, writeSessionTarget } from "../src/session-target-store.ts";
import { writeState } from "../src/session-state.ts";

const HUB = "https://hub.example.test";
const NOW = 10 * 3600_000;
const CLIENTS: Client[] = [
  { id: "c-unassigned", name: "Sin determinar", code: "SIN", active: true, unassigned: true },
  { id: "c-acme", name: "Acme Corp", code: "acme", active: true },
  { id: "c-zed", name: "Zed Studio", code: "zed", active: true },
  { id: "c-empty", name: "Empty Co", code: "empty", active: true },
  { id: "c-old", name: "Old Client", code: "old", active: false },
];
const PROJECTS: Project[] = [
  { id: "p-web", name: "Web", code: "web", clientId: "c-acme", repoPaths: ["/work/acme/web"], active: true },
  { id: "p-api", name: "API", clientId: "c-acme", repoPaths: ["/work/acme/api"], active: true },
  { id: "p-dead", name: "Retired", clientId: "c-acme", repoPaths: [], active: false },
  { id: "p-zweb", name: "Zed Web", code: "zweb", clientId: "c-zed", repoPaths: [], active: true },
];
const TASKS: HubTask[] = [
  { id: "t-web", title: "Fix login", projectId: "p-web", status: "open" },
  { id: "t-api", title: "Ship endpoint", projectId: "p-api", status: "open" },
];

interface Fixture {
  dir: string; home: string; deps: CliDeps & { fetch: typeof fetch };
  target: () => string; fetched: string[]; cleanup: () => void;
}

function fixture(opts: { cache?: boolean; creds?: boolean; fetchMode?: "ok" | "fail" | "hang"; session?: string | null; cwd?: string } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-target-cli-dir-"));
  const home = mkdtempSync(join(tmpdir(), "kankaku-claude-target-cli-home-"));
  const cwd = opts.cwd ?? "/work/acme/web";
  mkdirSync(join(home, ".kankaku"), { recursive: true });
  if (opts.creds !== false) writeFileSync(join(home, ".kankaku", "credentials.json"), JSON.stringify({ url: HUB, email: "a@b.c", password: "pw" }));
  if (opts.cache !== false) {
    writeFileSync(join(home, ".kankaku", "catalog.json"), JSON.stringify({ fetchedAt: NOW - 2 * 3600_000, url: HUB, clients: CLIENTS, projects: PROJECTS, tasks: TASKS }));
  }
  const fetched: string[] = [];
  const mode = opts.fetchMode ?? "ok";
  const fetchStub: typeof fetch = async (input) => {
    const url = String(input);
    fetched.push(url);
    if (mode === "hang") return new Promise<Response>(() => {});
    if (mode === "fail") throw new Error("offline");
    if (url.includes("auth-with-password")) return Response.json({ token: "tk", record: { id: "u" } });
    const items = url.includes("/collections/clients/") ? CLIENTS
      : url.includes("/collections/projects/") ? PROJECTS.map((p) => ({ id: p.id, name: p.name, ...(p.code ? { code: p.code } : {}), client: p.clientId, repo_paths: p.repoPaths, active: p.active }))
      : TASKS.map((t) => ({ id: t.id, title: t.title, project: t.projectId, status: t.status }));
    return Response.json({ items, page: 1, perPage: 500, totalPages: 1, totalItems: items.length });
  };
  const session = opts.session === undefined ? "s1" : opts.session;
  const deps = {
    env: { KANKAKU_DIR: dir, HOME: home, ...(session ? { KANKAKU_CLAUDE_SESSION: session } : {}) },
    cwd, now: () => NOW, isAlive: () => true, pluginRoot: "/x", fetch: fetchStub, catalogTimeoutMs: 50,
  };
  return {
    dir, home, deps, fetched,
    target: () => join(dir, "claude", `${session ?? ""}.target.json`),
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); },
  };
}

const run = (f: Fixture, ...args: string[]) => runTargetCli(args, f.deps);
const lines = (...l: string[]) => l.join("\n") + "\n";
const CLIENT_LIST = ["  1. Acme Corp (acme)", "  2. Empty Co (empty)", "  3. Zed Studio (zed)"];
const HINT = "pick one with: /kankaku:target <number>";

test("no session found: a clear message, exit 1, nothing written", async () => {
  const f = fixture({ session: null });
  try {
    for (const args of [[], ["1"], ["clear"], ["acme", "web"]]) {
      const r = await runTargetCli(args, f.deps);
      assert.deepEqual(r, { stdout: "no active Claude Code session found for this folder\n", exitCode: 1 });
    }
    assert.equal(existsSync(join(f.dir, "claude")), false);
  } finally { f.cleanup(); }
});

test("the session is found from the pid walk", async () => {
  const f = fixture({ session: null });
  try {
    writeState(join(f.dir, "claude", "abc.state.json"), { pid: 300, parentPid: 1, cwd: f.deps.cwd, startedAt: 1, promptOpen: null, permissionOpen: null });
    const runPs = (pid: number) => ({ 500: { ppid: 300, comm: "node" }, 300: { ppid: 1, comm: "claude" } } as Record<number, { ppid: number; comm: string }>)[pid];
    const r = await runTargetCli([], { ...f.deps, pid: 500, runPs });
    assert.equal(r.exitCode, 0);
    assert.ok(existsSync(join(f.dir, "claude", "abc.target.json")));
  } finally { f.cleanup(); }
});

test("no argument: the current target and its source, then the active clients numbered, then the hint", async () => {
  const f = fixture();
  try {
    const r = await run(f);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, lines("target: Acme Corp · Web (source: repo_paths)", ...CLIENT_LIST, HINT));
    assert.ok(f.fetched.some((u) => u.includes("/collections/clients/")));
    assert.deepEqual(readSessionTarget(f.target())?.lastList, { kind: "clients", ids: ["c-acme", "c-empty", "c-zed"] });
  } finally { f.cleanup(); }
});

test("no argument in a folder with no target: 'target: none (reason)'", async () => {
  const f = fixture({ cwd: "/somewhere/else" });
  try {
    assert.equal((await run(f)).stdout, lines("target: none (no match for /somewhere/else)", ...CLIENT_LIST, HINT));
  } finally { f.cleanup(); }
});

test("the target line reports the session source after a pick", async () => {
  const f = fixture();
  try {
    await run(f, "zed", "zweb");
    assert.equal((await run(f)).stdout, lines("target: Zed Studio · Zed Web (source: session)", ...CLIENT_LIST, HINT));
    const status = await runCli(["status"], f.deps);
    assert.match(status.stdout, /^target: Zed Studio · Zed Web \(source: session\)\n/);
  } finally { f.cleanup(); }
});

test("a failed refresh falls back to the cache and says how old it is", async () => {
  for (const fetchMode of ["fail", "hang"] as const) {
    const f = fixture({ fetchMode });
    try {
      const r = await run(f);
      assert.equal(r.exitCode, 0, fetchMode);
      assert.equal(r.stdout, lines("catalog from cache, 2h old", "target: Acme Corp · Web (source: repo_paths)", ...CLIENT_LIST, HINT), fetchMode);
    } finally { f.cleanup(); }
  }
});

test("no cache and no hub: 'no catalog', exit 1, nothing written", async () => {
  const noHub = fixture({ cache: false, creds: false });
  const offline = fixture({ cache: false, fetchMode: "fail" });
  try {
    for (const f of [noHub, offline]) {
      for (const args of [[], ["1"], ["acme"], ["acme", "web"]]) {
        const r = await runTargetCli(args, f.deps);
        assert.deepEqual(r, { stdout: "no catalog: configure the hub or run kankaku catalog refresh\n", exitCode: 1 });
      }
      assert.equal(existsSync(f.target()), false);
    }
  } finally { noHub.cleanup(); offline.cleanup(); }
});

test("picking a client by number sets it with no project, prints its projects numbered and stores that list", async () => {
  const f = fixture();
  try {
    await run(f);
    const r = await run(f, "1");
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, lines("client set to Acme Corp", "  1. API", "  2. Web (web)", HINT));
    assert.deepEqual(readSessionTarget(f.target()), {
      clientId: "c-acme", pickedTargetAt: NOW, lastList: { kind: "projects", ids: ["p-api", "p-web"] },
    });
  } finally { f.cleanup(); }
});

test("a client without active projects says so and prints no hint", async () => {
  const f = fixture();
  try {
    const r = await run(f, "empty");
    assert.equal(r.stdout, lines("client set to Empty Co", "no active projects"));
    assert.deepEqual(readSessionTarget(f.target())?.lastList, { kind: "projects", ids: [] });
  } finally { f.cleanup(); }
});

test("a following number, code or name picks the project of that client", async () => {
  for (const arg of ["2", "web", "WEB", "we"]) {
    const f = fixture();
    try {
      await run(f, "acme");
      const r = await run(f, arg);
      assert.equal(r.exitCode, 0, arg);
      assert.equal(r.stdout, lines("target set to Acme Corp · Web"), arg);
      const stored = readSessionTarget(f.target());
      assert.equal(stored?.clientId, "c-acme");
      assert.equal(stored?.projectId, "p-web");
      assert.equal(stored?.pickedTargetAt, NOW);
    } finally { f.cleanup(); }
  }
});

test("after a project is picked the projects list stays valid to switch project by number", async () => {
  const f = fixture();
  try {
    await run(f, "acme");
    await run(f, "2");
    assert.equal((await run(f, "1")).stdout, lines("target set to Acme Corp · API"));
  } finally { f.cleanup(); }
});

test("a client by code or by unique name substring", async () => {
  const f = fixture();
  try {
    assert.match((await run(f, "ZED")).stdout, /^client set to Zed Studio\n/);
    assert.match((await run(f, "studio")).stdout, /^client set to Zed Studio\n/);
    assert.match((await run(f, "acme", "corp")).stdout, /^client set to Acme Corp\n/);
  } finally { f.cleanup(); }
});

test("client and project together, by code and by name", async () => {
  const f = fixture();
  try {
    assert.equal((await run(f, "acme", "api")).stdout, lines("target set to Acme Corp · API"));
    assert.deepEqual(readSessionTarget(f.target()), { clientId: "c-acme", projectId: "p-api", pickedTargetAt: NOW, lastList: { kind: "tasks", ids: [] } });
    assert.equal((await run(f, "Zed", "Studio", "zed", "web")).stdout, lines("target set to Zed Studio · Zed Web"));
    assert.equal(readSessionTarget(f.target())?.projectId, "p-zweb");
  } finally { f.cleanup(); }
});

test("a project of another client, an inactive one and an unknown one change nothing and exit 1", async () => {
  const f = fixture();
  try {
    await run(f, "acme", "web");
    const before = readFileSync(f.target(), "utf8");
    for (const args of [["acme", "zweb"], ["acme", "retired"], ["acme", "nothing"], ["nothing", "web"]]) {
      const r = await run(f, ...args);
      assert.equal(r.exitCode, 1, args.join(" "));
      assert.doesNotMatch(r.stdout, /set to/, args.join(" "));
    }
    assert.match((await run(f, "acme", "zweb")).stdout, /Zed Web belongs to Zed Studio, not Acme Corp/);
    assert.equal(readFileSync(f.target(), "utf8"), before);
  } finally { f.cleanup(); }
});

test("text or numbers that match nothing change nothing, exit 1", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await run(f, "nothing-like-this"), { stdout: 'no client matches "nothing-like-this"\n', exitCode: 1 });
    for (const arg of ["old", "SIN", "Sin determinar"]) assert.equal((await run(f, arg)).exitCode, 1, arg); // inactive, unassigned
    assert.equal((await run(f, "1")).exitCode, 1); // no list shown yet
    assert.equal(existsSync(f.target()), false);
    await run(f);
    const before = readFileSync(f.target(), "utf8");
    const r = await run(f, "9");
    assert.deepEqual(r, { stdout: "9 is not on the list (1-3)\n", exitCode: 1 });
    assert.equal(readFileSync(f.target(), "utf8"), before);
  } finally { f.cleanup(); }
});

test("an ambiguous name prints the candidates numbered, changes the target nothing and makes them pickable", async () => {
  const f = fixture();
  try {
    await run(f, "zed", "zweb");
    const r = await run(f, "e"); // Acme Corp, Empty Co and Zed Studio all contain an "e"
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, lines('several clients match "e":', ...CLIENT_LIST, HINT));
    const stored = readSessionTarget(f.target());
    assert.equal(stored?.clientId, "c-zed");
    assert.equal(stored?.projectId, "p-zweb");
    assert.deepEqual(stored?.lastList, { kind: "clients", ids: ["c-acme", "c-empty", "c-zed"] });
    assert.match((await run(f, "3")).stdout, /^client set to Zed Studio\n/);
  } finally { f.cleanup(); }
});

test("clear removes the target and reports what the automatic resolution gives now", async () => {
  const f = fixture();
  try {
    await run(f, "zed", "zweb");
    const r = await run(f, "clear");
    assert.deepEqual(r, { stdout: lines("target cleared for this session; back to Acme Corp · Web (source: repo_paths)"), exitCode: 0 });
    assert.deepEqual(readSessionTarget(f.target()), { lastList: { kind: "tasks", ids: [] } });
    assert.match((await run(f)).stdout, /^target: Acme Corp · Web \(source: repo_paths\)\n/);
  } finally { f.cleanup(); }
});

test("clear in a folder with no automatic target says none, and without a session target says so", async () => {
  const f = fixture({ cwd: "/somewhere/else" });
  try {
    assert.equal((await run(f, "clear")).stdout, "no session target to clear\n");
    await run(f, "acme", "web");
    assert.equal((await run(f, "clear")).stdout, lines("target cleared for this session; back to none (no match for /somewhere/else)"));
  } finally { f.cleanup(); }
});

test("clear works offline and with no catalog", async () => {
  const f = fixture({ cache: false, fetchMode: "fail" });
  try {
    writeSessionTarget(f.target(), { clientId: "c-acme", projectId: "p-web", pickedTargetAt: 1, lastList: { kind: "projects", ids: [] } });
    assert.equal((await run(f, "clear")).stdout, lines("target cleared for this session; back to none (no catalog cache)"));
    assert.equal(readSessionTarget(f.target())?.clientId, undefined);
  } finally { f.cleanup(); }
});

const linked = (f: Fixture, taskId: string, title: string, projectId: string, extra: { clientId?: string } = {}) =>
  writeSessionTarget(f.target(), { ...extra, hubTaskId: taskId, hubTaskTitle: title, projectId, pickedAt: 1, lastList: { kind: "projects", ids: ["p-api", "p-web"] } });

test("task-link rule: picking a project that holds the linked task keeps the link", async () => {
  const f = fixture();
  try {
    linked(f, "t-web", "Fix login", "p-web", { clientId: "c-acme" });
    const r = await run(f, "web");
    assert.equal(r.stdout, lines("target set to Acme Corp · Web", "task link kept"));
    assert.equal(readSessionTarget(f.target())?.hubTaskId, "t-web");
  } finally { f.cleanup(); }
});

test("task-link rule: switching to another project drops the link and says why", async () => {
  const f = fixture();
  try {
    linked(f, "t-web", "Fix login", "p-web", { clientId: "c-acme" });
    const r = await run(f, "api");
    assert.equal(r.stdout, lines("target set to Acme Corp · API", "task link dropped (Fix login is not in API)"));
    const stored = readSessionTarget(f.target());
    assert.equal(stored?.hubTaskId, undefined);
    assert.equal(stored?.hubTaskTitle, undefined);
    assert.equal(stored?.projectId, "p-api");
  } finally { f.cleanup(); }
});

test("task-link rule: picking a client always drops the link (no project yet)", async () => {
  const f = fixture();
  try {
    linked(f, "t-web", "Fix login", "p-web", { clientId: "c-acme" });
    const r = await run(f, "acme");
    assert.equal(r.stdout, lines("client set to Acme Corp", "task link dropped (Fix login needs a project)", "  1. API", "  2. Web (web)", HINT));
    assert.equal(readSessionTarget(f.target())?.hubTaskId, undefined);
  } finally { f.cleanup(); }
});

test("task-link rule: client and project together follow the same rule", async () => {
  const f = fixture();
  try {
    linked(f, "t-web", "Fix login", "p-web");
    assert.equal((await run(f, "acme", "web")).stdout, lines("target set to Acme Corp · Web", "task link kept"));
    assert.equal(readSessionTarget(f.target())?.hubTaskId, "t-web");
    assert.equal((await run(f, "zed", "zweb")).stdout, lines("target set to Zed Studio · Zed Web", "task link dropped (Fix login is not in Zed Web)"));
  } finally { f.cleanup(); }
});

test("task-link rule: clear keeps a link that belongs to the automatic project and drops the others", async () => {
  const f = fixture(); // automatic: Acme Corp · Web
  try {
    linked(f, "t-web", "Fix login", "p-web", { clientId: "c-acme" });
    assert.equal((await run(f, "clear")).stdout, lines("target cleared for this session; back to Acme Corp · Web (source: repo_paths)", "task link kept"));
    assert.equal(readSessionTarget(f.target())?.hubTaskId, "t-web");
    linked(f, "t-api", "Ship endpoint", "p-api", { clientId: "c-acme" });
    assert.equal((await run(f, "clear")).stdout, lines("target cleared for this session; back to Acme Corp · Web (source: repo_paths)", "task link dropped (Ship endpoint is not in Web)"));
    assert.equal(readSessionTarget(f.target())?.hubTaskId, undefined);
  } finally { f.cleanup(); }
});

test("no link, no task-link line", async () => {
  const f = fixture();
  try {
    assert.equal((await run(f, "acme", "api")).stdout, lines("target set to Acme Corp · API"));
  } finally { f.cleanup(); }
});

test("runCli routes the target command, and the config.json is never written", async () => {
  const f = fixture();
  try {
    const r = await runCli(["target", "acme", "web"], f.deps);
    assert.equal(r.stdout, lines("target set to Acme Corp · Web"));
    assert.equal(existsSync(join(f.dir, "config.json")), false);
  } finally { f.cleanup(); }
});
