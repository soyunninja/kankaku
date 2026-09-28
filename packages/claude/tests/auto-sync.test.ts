import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoSync } from "../src/auto-sync.ts";
import { JsonlWorkLog } from "kankaku/hub";
import { emptyUsage, WORK_RECORD_SCHEMA } from "kankaku/domain";

test("auto sync disabled or unconfigured/invalid never fetches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-auto-sync-"));
  const home = mkdtempSync(join(tmpdir(), "kankaku-auto-home-"));
  let calls = 0;
  const fetchStub: typeof fetch = async () => { calls++; throw new Error("unexpected network"); };
  const base = { cwd: dir, now: () => Date.now(), fetch: fetchStub, stderr: () => {} };
  try {
    await autoSync("session_start", { ...base, env: { HOME: home, KANKAKU_DIR: dir, KANKAKU_SYNC_AUTO: "0", KANKAKU_PB_URL: "https://hub.example", KANKAKU_PB_EMAIL: "a@b.co", KANKAKU_PB_PASSWORD: "pass" } });
    await autoSync("session_start", { ...base, env: { HOME: home, KANKAKU_DIR: dir } });
    await autoSync("session_start", { ...base, env: { HOME: home, KANKAKU_DIR: dir, KANKAKU_PB_URL: "http://hub.example", KANKAKU_PB_EMAIL: "a@b.co", KANKAKU_PB_PASSWORD: "pass" } });
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("auto sync swallows network failures and reports through stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-auto-sync-"));
  const home = mkdtempSync(join(tmpdir(), "kankaku-auto-home-"));
  const errors: string[] = [];
  new JsonlWorkLog(dir).append({ schema: WORK_RECORD_SCHEMA, id: "task-1", prompt: "private", startedAt: "2026-01-01T00:00:00.000Z", settledAt: "2026-01-01T00:00:01.000Z", wallMs: 1000, waitingMs: 0, workMs: 1000, runs: 1, turns: 1, tools: {}, subagents: [], usage: emptyUsage(), status: "completed", role: "orchestrator", pid: 1, parentPid: 0, project: "/repo" });
  try {
    await autoSync("agent_settled", {
      env: { HOME: home, KANKAKU_DIR: dir, KANKAKU_PB_URL: "https://hub.example", KANKAKU_PB_EMAIL: "a@b.co", KANKAKU_PB_PASSWORD: "pass" },
      cwd: dir, now: () => Date.parse("2026-01-02T00:00:00Z"), fetch: async () => { throw new Error("offline"); }, stderr: (message) => errors.push(message),
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /offline/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("auto sync uses public sink and trigger while preserving default prompt privacy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-auto-sync-"));
  const home = mkdtempSync(join(tmpdir(), "kankaku-auto-home-"));
  const requests: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  new JsonlWorkLog(dir).append({ schema: WORK_RECORD_SCHEMA, id: "task-1", prompt: "private", startedAt: "2026-01-01T00:00:00.000Z", settledAt: "2026-01-01T00:00:01.000Z", wallMs: 1000, waitingMs: 0, workMs: 1000, runs: 1, turns: 1, tools: {}, subagents: [], usage: emptyUsage(), status: "completed", role: "orchestrator", pid: 1, parentPid: 0, project: "/repo" });
  const fetchStub: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("task_entries") && init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (url.includes("auth-with-password")) return Response.json({ token: "token", record: { id: "user" } });
    if (init?.method === "POST") return Response.json({ id: "entry-1" });
    return Response.json({ items: [], page: 1, totalPages: 1, totalItems: 0 });
  };
  try {
    await autoSync("session_start", { env: { HOME: home, KANKAKU_DIR: dir, KANKAKU_PB_URL: "https://hub.example", KANKAKU_PB_EMAIL: "a@b.co", KANKAKU_PB_PASSWORD: "pass" }, cwd: dir, now: () => Date.parse("2026-01-02T00:00:00Z"), fetch: fetchStub, stderr: () => {} });
    assert.ok(requests.some((url) => url.includes("auth-with-password")), "configured heavy hook contacts hub");
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.prompt, "");
    assert.equal(bodies[0]?.agent, "claude-code");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
