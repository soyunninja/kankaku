import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeProjectSyncStatus,
  createCatalog,
  refreshCatalog,
  resolveHub,
  syncProject,
} from "../src/adapters/hub.ts";
import type { ProjectRef } from "../src/ports/project-source.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pageResponse(items: unknown[]): Response {
  return jsonResponse(200, { page: 1, perPage: 200, totalItems: items.length, totalPages: 1, items });
}

interface FakeCall {
  url: string;
  method: string;
  body: unknown;
}

function makeFetch(calls: FakeCall[], handler: (url: string, method: string, body: unknown) => Response) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(input), method, body });
    return handler(String(input), method, body);
  }) as typeof fetch;
}

function baseHandler(url: string, method: string): Response {
  if (url.endsWith("/api/collections/users/auth-with-password")) return jsonResponse(200, { token: "tok", record: { id: "u1" } });
  if (url.includes("/api/collections/clients/records")) return pageResponse([]);
  if (url.includes("/api/collections/projects/records")) return pageResponse([]);
  if (url.includes("/api/collections/tasks/records")) return pageResponse([]);
  if (url.includes("/api/collections/task_entries/records") && method === "GET") return pageResponse([]);
  if (url.includes("/api/collections/task_entries/records") && method === "POST") return jsonResponse(200, { id: "te1" });
  if (url.includes("/api/collections/work_records/records") && method === "GET") return pageResponse([]);
  if (url.includes("/api/collections/work_records/records") && method === "POST") return jsonResponse(200, { id: "wr1" });
  return jsonResponse(404, { message: "not found" });
}

function tmpHomeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-hub-home-"));
}

function fixtureLine(id: string): string {
  return JSON.stringify({
    schema: 1,
    id,
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "demo",
    prompt: "hello",
    startedAt: "2026-09-27T09:00:00.000Z",
    settledAt: "2026-09-27T09:01:00.000Z",
    wallMs: 60000,
    waitingMs: 0,
    workMs: 60000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
    status: "completed",
  });
}

function tmpProject(): ProjectRef {
  const root = mkdtempSync(join(tmpdir(), "kankaku-cli-hub-project-"));
  mkdirSync(join(root, ".kankaku"), { recursive: true });
  writeFileSync(join(root, ".kankaku", "worklog.jsonl"), `${fixtureLine("r1")}\n`);
  return { name: "demo", dir: root };
}

test("resolveHub reports unconfigured when no credentials are available", () => {
  const homeDir = tmpHomeDir();
  try {
    const result = resolveHub({ env: {}, homeDir: () => homeDir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not configured/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveHub resolves credentials from the environment", () => {
  const homeDir = tmpHomeDir();
  try {
    const result = resolveHub({
      env: { KANKAKU_PB_URL: "https://pb.example.com", KANKAKU_PB_EMAIL: "a@b.com", KANKAKU_PB_PASSWORD: "secret" },
      homeDir: () => homeDir,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.credentials, { url: "https://pb.example.com", email: "a@b.com", password: "secret" });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveHub rejects an invalid hub URL", () => {
  const homeDir = tmpHomeDir();
  try {
    const result = resolveHub({
      env: { KANKAKU_PB_URL: "not-a-url", KANKAKU_PB_EMAIL: "a@b.com", KANKAKU_PB_PASSWORD: "secret" },
      homeDir: () => homeDir,
    });
    assert.equal(result.ok, false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCatalog + refreshCatalog fetches and caches a snapshot to disk under homeDir", async () => {
  const homeDir = tmpHomeDir();
  try {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(calls, (url, method) => {
      if (url.includes("/api/collections/clients/records")) return pageResponse([{ id: "c1", name: "Acme", code: "acme", active: true }]);
      return baseHandler(url, method);
    });

    const catalog = createCatalog(
      { url: "https://pb.example.com", email: "a@b.com", password: "secret" },
      { homeDir: () => homeDir, now: () => 1_000_000, fetch: fetchFn },
    );

    const snapshot = await refreshCatalog(catalog);
    assert.ok(snapshot);
    assert.equal(snapshot?.clients.length, 1);
    assert.equal(snapshot?.clients[0]?.name, "Acme");

    const onDisk = JSON.parse(readFileSync(join(homeDir, ".kankaku", "catalog.json"), "utf8"));
    assert.equal(onDisk.url, "https://pb.example.com");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("computeProjectSyncStatus reports a pending task with no network and no prior state", () => {
  const project = tmpProject();
  try {
    const status = computeProjectSyncStatus(project, { url: "https://pb.example.com", email: "a@b.com", password: "secret" }, {});
    assert.equal(status.pending, 1);
    assert.equal(status.state, undefined);
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
  }
});

test("syncProject uploads the pending task and stamps agent/plugin identity from the TUI fallback", async () => {
  const project = tmpProject();
  const homeDir = tmpHomeDir();
  try {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(calls, baseHandler);

    const summary = await syncProject(
      project,
      { url: "https://pb.example.com", email: "a@b.com", password: "secret" },
      {},
      { env: {}, homeDir: () => homeDir, now: () => 1_000_000, hostname: () => "test-machine", fetch: fetchFn },
    );

    assert.equal(summary.uploaded, 1);
    assert.equal(summary.failed.length, 0);

    const created = calls.find((call) => call.url.includes("/api/collections/task_entries/records") && call.method === "POST");
    assert.ok(created);
    const payload = created?.body as Record<string, unknown>;
    assert.equal(payload.agent, "unknown");
    assert.equal(payload.plugin, "kankaku-tui");
    assert.equal(typeof payload.plugin_version, "string");
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
