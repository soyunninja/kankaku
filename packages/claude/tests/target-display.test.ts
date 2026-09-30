import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, Project } from "kankaku-pi/domain";
import { runCli, type CliDeps } from "../src/cli-core.ts";
import { runDoctor } from "../src/doctor.ts";

const HUB = "https://hub.example.test";
const CLIENTS: Client[] = [{ id: "c-acme", name: "Acme Corp", code: "acme", active: true }];

function fixture(withCache: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-display-dir-"));
  const home = mkdtempSync(join(tmpdir(), "kankaku-claude-display-home-"));
  const pluginRoot = mkdtempSync(join(tmpdir(), "kankaku-claude-display-plugin-"));
  const cwd = mkdtempSync(join(tmpdir(), "kankaku-claude-display-cwd-"));
  if (withCache) {
    const projects: Project[] = [{ id: "p-web", name: "Web", clientId: "c-acme", repoPaths: [cwd], active: true }];
    mkdirSync(join(home, ".kankaku"), { recursive: true });
    writeFileSync(join(home, ".kankaku", "credentials.json"), JSON.stringify({ url: HUB, email: "a@b.c", password: "pw" }));
    writeFileSync(join(home, ".kankaku", "catalog.json"), JSON.stringify({ fetchedAt: 1, url: HUB, clients: CLIENTS, projects }));
  }
  const deps: CliDeps = { env: { KANKAKU_DIR: dir, HOME: home }, cwd, now: () => 0, isAlive: () => true, pluginRoot };
  return { dir, home, pluginRoot, cwd, deps, cleanup: () => { for (const p of [dir, home, pluginRoot, cwd]) rmSync(p, { recursive: true, force: true }); } };
}

test("status prints the resolved target and its source, then the sessions", async () => {
  const f = fixture(true);
  try {
    const result = await runCli(["status"], f.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "target: Acme Corp · Web (source: repo_paths)\ntask: none\nNo active sessions.\n");
  } finally { f.cleanup(); }
});

test("status prints 'target: none' with the reason when there is no cache", async () => {
  const f = fixture(false);
  try {
    const result = await runCli(["status"], f.deps);
    assert.equal(result.stdout, "target: none (no catalog cache)\ntask: none\nNo active sessions.\n");
  } finally { f.cleanup(); }
});

test("status reports the project config source, and no match when the cwd is unknown", async () => {
  const f = fixture(true);
  try {
    writeFileSync(join(f.dir, "config.json"), JSON.stringify({ clientId: "c-acme" }));
    assert.match((await runCli(["status"], f.deps)).stdout, /^target: Acme Corp \(source: project config\)\n/);
    rmSync(join(f.dir, "config.json"));
    const other = { ...f.deps, cwd: "/somewhere/else" };
    assert.match((await runCli(["status"], other)).stdout, /^target: none \(no match for \/somewhere\/else\)\n/);
  } finally { f.cleanup(); }
});

test("doctor has a work target section with the same line", () => {
  const f = fixture(true);
  try {
    const output = runDoctor(f.deps);
    assert.match(output, /## Work target\ntarget: Acme Corp · Web \(source: repo_paths\)\n/);
  } finally { f.cleanup(); }
  const g = fixture(false);
  try {
    assert.match(runDoctor(g.deps), /## Work target\ntarget: none \(no catalog cache\)\n/);
  } finally { g.cleanup(); }
});

test("status and doctor report source: session when the /kankaku:target override is active", async () => {
  const f = fixture(true);
  try {
    writeFileSync(join(f.home, ".kankaku", "catalog.json"), JSON.stringify({
      fetchedAt: 1, url: HUB,
      clients: [...CLIENTS, { id: "c-zed", name: "Zed Studio", code: "zed", active: true }],
      projects: [{ id: "p-web", name: "Web", clientId: "c-acme", repoPaths: [f.cwd], active: true }],
    }));
    mkdirSync(join(f.dir, "claude"), { recursive: true });
    writeFileSync(join(f.dir, "claude", "s1.target.json"), JSON.stringify({ clientId: "c-zed", pickedTargetAt: 1, lastList: { kind: "clients", ids: [] } }));
    const deps = { ...f.deps, env: { ...f.deps.env, KANKAKU_CLAUDE_SESSION: "s1" } };
    assert.match((await runCli(["status"], deps)).stdout, /^target: Zed Studio \(source: session\)\n/);
    assert.match(runDoctor(deps), /## Work target\ntarget: Zed Studio \(source: session\)\n/);
  } finally { f.cleanup(); }
});
