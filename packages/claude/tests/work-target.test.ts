import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTasks, resolveTaskAssignment, buildTaskEntryCreatePayload, emptyUsage, WORK_RECORD_SCHEMA } from "kankaku-pi/domain";
import type { Client, Project, WorkRecordCore } from "kankaku-pi/domain";
import { buildClaudeRecord } from "../src/record.ts";
import { formatTargetLine, resolveClaudeWorkTarget } from "../src/work-target.ts";

const HUB = "https://hub.example.test";

const CLIENTS: Client[] = [
  { id: "c-unassigned", name: "Sin determinar", code: "SIN", active: true, unassigned: true },
  { id: "c-acme", name: "Acme Corp", code: "acme", active: true },
  { id: "c-bad", name: "Bad Code", code: "has space", active: true },
  { id: "c-off", name: "Retired", code: "off", active: false },
];

const PROJECTS: Project[] = [
  { id: "p-web", name: "Web", clientId: "c-acme", repoPaths: ["/work/acme/web"], active: true },
  { id: "p-api", name: "API", clientId: "c-acme", repoPaths: ["/work/acme/api"], active: true },
  { id: "p-bad", name: "Bad", clientId: "c-bad", repoPaths: ["/work/bad"], active: true },
  { id: "p-off", name: "Off", clientId: "c-off", repoPaths: ["/work/off"], active: true },
  { id: "p-un", name: "Unassigned proj", clientId: "c-unassigned", repoPaths: ["/work/un"], active: true },
];

interface Fixture {
  home: string;
  kankakuDir: string;
  env: NodeJS.ProcessEnv;
  writeCache: (overrides?: { url?: string; clients?: Client[]; projects?: Project[] }) => void;
  writeConfig: (config: unknown) => void;
  cleanup: () => void;
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "kankaku-claude-target-home-"));
  const kankakuDir = mkdtempSync(join(tmpdir(), "kankaku-claude-target-dir-"));
  mkdirSync(join(home, ".kankaku"), { recursive: true });
  writeFileSync(join(home, ".kankaku", "credentials.json"), JSON.stringify({ url: HUB, email: "a@b.c", password: "pw" }));
  return {
    home,
    kankakuDir,
    env: { HOME: home },
    writeCache: (overrides = {}) =>
      writeFileSync(
        join(home, ".kankaku", "catalog.json"),
        JSON.stringify({ fetchedAt: 1, url: overrides.url ?? HUB, clients: overrides.clients ?? CLIENTS, projects: overrides.projects ?? PROJECTS }),
      ),
    writeConfig: (config) => writeFileSync(join(kankakuDir, "config.json"), typeof config === "string" ? config : JSON.stringify(config)),
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(kankakuDir, { recursive: true, force: true });
    },
  };
}

function resolve(f: Fixture, cwd: string, env: NodeJS.ProcessEnv = f.env) {
  return resolveClaudeWorkTarget({ cwd, kankakuDir: f.kankakuDir, homeDir: f.home, env });
}

test("a repo_paths match resolves the target, the source and the legacy client label", () => {
  const f = fixture();
  try {
    f.writeCache();
    const result = resolve(f, "/work/acme/web/packages/x");
    assert.equal(result.target?.clientId, "c-acme");
    assert.equal(result.target?.projectId, "p-web");
    assert.equal(result.source, "repoPaths");
    assert.equal(result.legacyClient, "acme");
    assert.equal(result.reason, undefined);
  } finally {
    f.cleanup();
  }
});

test("project config ids win over a repo_paths match", () => {
  const f = fixture();
  try {
    f.writeCache();
    f.writeConfig({ clientId: "c-acme", projectId: "p-api" });
    const result = resolve(f, "/work/acme/web");
    assert.equal(result.target?.projectId, "p-api");
    assert.equal(result.source, "project");
  } finally {
    f.cleanup();
  }
});

test("project config ids that no longer exist in the catalog fall through to repo_paths", () => {
  const f = fixture();
  try {
    f.writeCache();
    f.writeConfig({ clientId: "c-gone", projectId: "p-gone" });
    const result = resolve(f, "/work/acme/web");
    assert.equal(result.target?.projectId, "p-web");
    assert.equal(result.source, "repoPaths");
  } finally {
    f.cleanup();
  }
});

test("inactive and unassigned catalog entries are never used as a target", () => {
  const f = fixture();
  try {
    f.writeCache();
    for (const cwd of ["/work/off", "/work/un"]) {
      const result = resolve(f, cwd);
      assert.equal(result.target, undefined);
      assert.equal(result.source, undefined);
      assert.equal(result.reason, `no match for ${cwd}`);
    }
    f.writeConfig({ clientId: "c-unassigned" });
    assert.equal(resolve(f, "/nowhere").target, undefined);
  } finally {
    f.cleanup();
  }
});

test("no cache file: no target, reason 'no catalog cache', no throw", () => {
  const f = fixture();
  try {
    const result = resolve(f, "/work/acme/web");
    assert.deepEqual(result, { reason: "no catalog cache" });
  } finally {
    f.cleanup();
  }
});

test("malformed cache: no target, reason 'no catalog cache'", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.home, ".kankaku", "catalog.json"), "{not json");
    assert.deepEqual(resolve(f, "/work/acme/web"), { reason: "no catalog cache" });
    writeFileSync(join(f.home, ".kankaku", "catalog.json"), JSON.stringify({ clients: "x" }));
    assert.deepEqual(resolve(f, "/work/acme/web"), { reason: "no catalog cache" });
  } finally {
    f.cleanup();
  }
});

test("a cache written for another hub url, or no hub credentials at all, count as no catalog cache", () => {
  const f = fixture();
  try {
    f.writeCache({ url: "https://other.example.test" });
    assert.equal(resolve(f, "/work/acme/web").reason, "no catalog cache");
    f.writeCache();
    rmSync(join(f.home, ".kankaku", "credentials.json"));
    assert.equal(resolve(f, "/work/acme/web").reason, "no catalog cache");
  } finally {
    f.cleanup();
  }
});

test("a readable cache with no matching project reports 'no match for <cwd>'", () => {
  const f = fixture();
  try {
    f.writeCache();
    const result = resolve(f, "/elsewhere");
    assert.equal(result.target, undefined);
    assert.equal(result.reason, "no match for /elsewhere");
  } finally {
    f.cleanup();
  }
});

test("the legacy client label is omitted when the client code is invalid against CLIENT_PATTERN", () => {
  const f = fixture();
  try {
    f.writeCache();
    const result = resolve(f, "/work/bad");
    assert.equal(result.target?.clientId, "c-bad");
    assert.equal("legacyClient" in result, false);
    // Mirrors pi: with a hub target the env label is not consulted.
    const withEnv = resolve(f, "/work/bad", { ...f.env, KANKAKU_CLIENT: "from-env" });
    assert.equal("legacyClient" in withEnv, false);
  } finally {
    f.cleanup();
  }
});

test("without a hub target the legacy label resolves from KANKAKU_CLIENT, then the project config client", () => {
  const f = fixture();
  try {
    f.writeCache();
    f.writeConfig({ client: "from-config" });
    assert.equal(resolve(f, "/elsewhere").legacyClient, "from-config");
    assert.equal(resolve(f, "/elsewhere", { ...f.env, KANKAKU_CLIENT: "from-env" }).legacyClient, "from-env");
    assert.equal(resolve(f, "/elsewhere", { ...f.env, KANKAKU_CLIENT: "not valid!" }).legacyClient, "from-config");
    // No cache either: the legacy label still resolves.
    rmSync(join(f.home, ".kankaku", "catalog.json"));
    const noCache = resolve(f, "/elsewhere", { ...f.env, KANKAKU_CLIENT: "from-env" });
    assert.equal(noCache.legacyClient, "from-env");
    assert.equal(noCache.reason, "no catalog cache");
  } finally {
    f.cleanup();
  }
});

test("a record stamped with a resolved target is assigned to that client and project, not to the unassigned client", () => {
  const f = fixture();
  try {
    f.writeCache();
    const assignment = resolve(f, "/work/acme/web");
    const core: WorkRecordCore = {
      schema: WORK_RECORD_SCHEMA, id: "id-1", prompt: "p", startedAt: new Date(1000).toISOString(),
      settledAt: new Date(2000).toISOString(), wallMs: 1000, waitingMs: 0, workMs: 1000, runs: 1, turns: 1,
      tools: {}, subagents: [], usage: emptyUsage(), status: "completed",
    };
    const record = buildClaudeRecord(core, { pid: 1, parentPid: 2, cwd: "/work/acme/web", startedAt: 1, promptOpen: null, permissionOpen: null }, "s1", undefined, assignment);
    assert.equal(record.clientId, "c-acme");
    assert.equal(record.clientName, "Acme Corp");
    assert.equal(record.projectId, "p-web");
    assert.equal(record.projectName, "Web");
    assert.equal(record.client, "acme");

    const [task] = buildTasks([record]);
    const resolved = resolveTaskAssignment(task!, CLIENTS, PROJECTS, []);
    assert.equal(resolved.clientId, "c-acme");
    assert.equal(resolved.projectId, "p-web");
    assert.equal(resolved.routedToUnassigned, false);
    const payload = buildTaskEntryCreatePayload(task!, { clients: CLIENTS, projects: PROJECTS, tasks: [], machine: "m", promptMode: "none", agent: "unknown", plugin: "kankaku-tui" });
    assert.equal(payload.client, "c-acme");
    assert.equal(payload.project, "p-web");
    assert.notEqual(payload.client, "c-unassigned");

    const bare = buildClaudeRecord(core, { pid: 1, parentPid: 2, cwd: "/x", startedAt: 1, promptOpen: null, permissionOpen: null }, "s1", undefined);
    assert.equal(resolveTaskAssignment(buildTasks([bare])[0]!, CLIENTS, PROJECTS, []).routedToUnassigned, true);
  } finally {
    f.cleanup();
  }
});

test("formatTargetLine shows the label and source, or none with the reason", () => {
  const f = fixture();
  try {
    f.writeCache();
    assert.equal(formatTargetLine(resolve(f, "/work/acme/web")), "target: Acme Corp · Web (source: repo_paths)");
    f.writeConfig({ clientId: "c-acme" });
    assert.equal(formatTargetLine(resolve(f, "/work/acme/web")), "target: Acme Corp (source: project config)");
    rmSync(join(f.kankakuDir, "config.json"));
    assert.equal(formatTargetLine(resolve(f, "/elsewhere")), "target: none (no match for /elsewhere)");
    assert.equal(formatTargetLine({}), "target: none (unresolved)");
  } finally {
    f.cleanup();
  }
});
