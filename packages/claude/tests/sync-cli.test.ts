import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlWorkLog, SyncStateStore } from "kankaku-pi/hub";
import { emptyUsage, WORK_RECORD_SCHEMA } from "kankaku-pi/domain";
import type { WorkRecord } from "kankaku-pi/domain";
import { runSyncCli } from "../src/sync-cli.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-sync-cli-"));
  const home = mkdtempSync(join(tmpdir(), "kankaku-sync-home-"));
  const env = { HOME: home, KANKAKU_DIR: dir };
  const deps = { env, cwd: dir, now: () => Date.parse("2026-01-02T00:00:00Z"), homeDir: () => home, hostname: () => "test-machine", fetch: (() => { throw new Error("network must not be used"); }) as typeof fetch };
  return { dir, home, deps, cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

function record(): WorkRecord {
  return { schema: WORK_RECORD_SCHEMA, id: "task-1", prompt: "secret prompt", startedAt: "2026-01-01T00:00:00.000Z", settledAt: "2026-01-01T00:00:01.000Z", wallMs: 1000, waitingMs: 0, workMs: 1000, runs: 1, turns: 1, tools: {}, subagents: [], usage: emptyUsage(), status: "completed", role: "orchestrator", pid: 1, parentPid: 0, project: "/repo" };
}

test("sync status is local-only and reports unconfigured pending state", async () => {
  const f = fixture();
  try {
    new JsonlWorkLog(f.dir).append(record());
    const result = await runSyncCli(["status"], f.deps);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /unconfigured/);
    assert.match(result.stdout, /pending: 1/);
    assert.match(result.stdout, /staleOutsideWindow: 0/);
    assert.match(result.stdout, /syncedThrough: none/);
  } finally { f.cleanup(); }
});

test("sync status reports persisted watermark, stale count and last error without network", async () => {
  const f = fixture();
  try {
    new JsonlWorkLog(f.dir).append(record());
    new SyncStateStore({ dir: f.dir, pid: 1 }).write({ target: "https://hub.example", hashes: {}, syncedThrough: "2026-01-03T00:00:00.000Z", lastError: { message: "offline", at: "2026-01-03T01:00:00.000Z" } });
    const result = await runSyncCli(["status"], { ...f.deps, env: { ...f.deps.env, KANKAKU_PB_URL: "https://hub.example", KANKAKU_PB_EMAIL: "a@b.co", KANKAKU_PB_PASSWORD: "test" } });
    assert.match(result.stdout, /configured/);
    assert.match(result.stdout, /staleOutsideWindow: 1/);
    assert.match(result.stdout, /syncedThrough: 2026-01-03/);
    assert.match(result.stdout, /last error: offline/);
  } finally { f.cleanup(); }
});

test("sync refuses missing credentials and invalid URL without a stack trace", async () => {
  const f = fixture();
  try {
    const missing = await runSyncCli([], f.deps);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr ?? "", /credentials/i);
    const invalid = await runSyncCli(["all"], { ...f.deps, env: { ...f.deps.env, KANKAKU_PB_URL: "http://remote.example", KANKAKU_PB_EMAIL: "a@b.co", KANKAKU_PB_PASSWORD: "test" } });
    assert.equal(invalid.exitCode, 1);
    assert.match(invalid.stderr ?? "", /URL|HTTPS/i);
    assert.doesNotMatch(invalid.stderr ?? "", /\bat\s+\S+\s+\(/);
  } finally { f.cleanup(); }
});

test("sync all sends Claude attribution and privacy defaults through the public sink", async () => {
  const f = fixture();
  try {
    new JsonlWorkLog(f.dir).append(record());
    new SyncStateStore({ dir: f.dir, pid: 1 }).write({ target: "https://hub.example", hashes: {}, syncedThrough: "2026-01-03T00:00:00.000Z" });
    const bodies: Record<string, unknown>[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.body && url.includes("task_entries")) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (url.includes("auth-with-password")) return Response.json({ token: "token", record: { id: "user" } });
      if (init?.method === "POST") return Response.json({ id: "entry-1" });
      return Response.json({ items: [], page: 1, totalPages: 1, totalItems: 0 });
    };
    const result = await runSyncCli(["all"], { ...f.deps, fetch: fetchStub, env: { ...f.deps.env, KANKAKU_PB_URL: "https://hub.example", KANKAKU_PB_EMAIL: "a@b.co", KANKAKU_PB_PASSWORD: "test", KANKAKU_SYNC_RECORDS: "0" } });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /uploaded: 1/);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.agent, "claude-code");
    assert.equal(bodies[0]?.plugin, "kankaku-claude");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(bodies[0]?.plugin_version, pkg.version);
    assert.equal(bodies[0]?.agent_version, undefined);
    assert.equal(bodies[0]?.machine, "test-machine");
    assert.equal(bodies[0]?.prompt, "");
  } finally { f.cleanup(); }
});
