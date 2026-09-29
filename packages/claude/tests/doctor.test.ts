import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlWorkLog, SyncStateStore } from "kankaku-pi/hub";
import { emptyUsage, WORK_RECORD_SCHEMA } from "kankaku-pi/domain";
import type { WorkRecord } from "kankaku-pi/domain";
import { runDoctor } from "../src/doctor.ts";
import { writeState } from "../src/session-state.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-work-"));
  const home = mkdtempSync(join(tmpdir(), "doctor-home-"));
  const pluginRoot = mkdtempSync(join(tmpdir(), "doctor-plugin-"));
  const env = { HOME: home, KANKAKU_DIR: dir };
  const deps = { env, cwd: dir, pluginRoot, now: () => Date.parse("2026-01-02T00:00:00Z"), isAlive: (pid: number) => pid === 111 };
  return { dir, home, pluginRoot, deps, cleanup: () => { for (const path of [dir, home, pluginRoot]) rmSync(path, { recursive: true, force: true }); } };
}

function record(): WorkRecord {
  return { schema: WORK_RECORD_SCHEMA, id: "id-1", prompt: "private prompt", startedAt: "2026-01-01T00:00:00.000Z", settledAt: "2026-01-01T00:00:01.000Z", wallMs: 1000, waitingMs: 0, workMs: 1000, runs: 1, turns: 1, tools: {}, subagents: [], usage: emptyUsage(), status: "completed", role: "orchestrator", pid: 1, parentPid: 0, project: "/repo" };
}

test("doctor reports empty, unconfigured local state without creating files", () => {
  const f = fixture();
  try {
    const output = runDoctor(f.deps);
    assert.match(output, /Package \/ plugin/);
    assert.match(output, /pluginRoot:/);
    assert.match(output, /Local files/);
    assert.match(output, /worklog: absent \(0 records\)/);
    assert.match(output, /Sessions \/ cost/);
    assert.match(output, /active sessions: 0/);
    assert.match(output, /cost files visible: no/);
    assert.match(output, /Hub \/ sync/);
    assert.match(output, /hub: unconfigured/);
    assert.match(output, /pending: 0/);
    assert.match(output, /Next actions/);
    assert.match(output, /kankaku:setup/);
    assert.doesNotMatch(output, /private prompt/);
  } finally { f.cleanup(); }
});

test("doctor reports configured pending local state, without leaking credentials or error contents", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.pluginRoot, ".claude-plugin"));
    writeFileSync(join(f.pluginRoot, "package.json"), JSON.stringify({ version: "9.1.0" }));
    writeFileSync(join(f.pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "test-plugin", version: "8.0.0" }));
    mkdirSync(join(f.pluginRoot, "commands"));
    writeFileSync(join(f.pluginRoot, "commands", "doctor.md"), "---\n---\n");
    mkdirSync(join(f.pluginRoot, "hooks"));
    writeFileSync(join(f.pluginRoot, "hooks", "hooks.json"), "{}");
    new JsonlWorkLog(f.dir).append(record());
    new JsonlWorkLog(f.dir).append({ ...record(), id: "id-2", startedAt: "2026-01-02T00:00:00.000Z", settledAt: "2026-01-02T00:00:01.000Z" });
    writeState(join(f.dir, "claude", "alive.state.json"), { pid: 111, parentPid: 1, cwd: f.dir, startedAt: 1, promptOpen: { id: "p", startedAt: 1, costAtStart: 0 }, permissionOpen: null });
    writeState(join(f.dir, "claude", "dead.state.json"), { pid: 222, parentPid: 1, cwd: f.dir, startedAt: 1, promptOpen: null, permissionOpen: null });
    mkdirSync(join(f.home, ".kankaku", "claude", "cost"), { recursive: true });
    writeFileSync(join(f.home, ".kankaku", "claude", "cost", "alive.json"), "{}");
    new SyncStateStore({ dir: f.dir, pid: 1 }).write({ target: "https://hub.example", hashes: {}, syncedThrough: "2026-01-03T00:00:00.000Z", lastError: { message: "secret-error-password", at: "2026-01-03T01:00:00.000Z" } });
    const output = runDoctor({ ...f.deps, env: { ...f.deps.env, KANKAKU_PB_URL: "https://hub.example", KANKAKU_PB_EMAIL: "private@example.com", KANKAKU_PB_PASSWORD: "secret-password" } });
    for (const expected of ["9.1.0", "test-plugin", "8.0.0", "worklog: present (2 records)", "active sessions: 2", "alive: 1", "dead: 1", "open prompts: 1", "cost files visible: yes", "hub: configured", "pending: 1", "staleOutsideWindow: 1", "syncedThrough: 2026-01-03", "last sync error: present", "kankaku:sync-status"]) assert.ok(output.includes(expected), expected);
    for (const secret of ["private@example.com", "secret-password", "secret-error-password", "private prompt", "https://hub.example"]) assert.ok(!output.includes(secret), secret);
  } finally { f.cleanup(); }
});

test("doctor distinguishes invalid hub URL without exposing its value", () => {
  const f = fixture();
  try {
    const output = runDoctor({ ...f.deps, env: { ...f.deps.env, KANKAKU_PB_URL: "http://private.example", KANKAKU_PB_EMAIL: "private@example.com", KANKAKU_PB_PASSWORD: "secret-password" } });
    assert.match(output, /hub: invalid URL/);
    assert.doesNotMatch(output, /private\.example|private@example\.com|secret-password/);
  } finally { f.cleanup(); }
});
