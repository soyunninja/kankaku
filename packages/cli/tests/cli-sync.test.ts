import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.tsx";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pageResponse(items: unknown[]): Response {
  return jsonResponse(200, { page: 1, perPage: 200, totalItems: items.length, totalPages: 1, items });
}

function fakeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/collections/users/auth-with-password")) return jsonResponse(200, { token: "tok", record: { id: "u1" } });
    if (url.includes("/api/collections/clients/records")) return pageResponse([]);
    if (url.includes("/api/collections/projects/records")) return pageResponse([]);
    if (url.includes("/api/collections/tasks/records")) return pageResponse([]);
    if (url.includes("/api/collections/task_entries/records") && method === "GET") return pageResponse([]);
    if (url.includes("/api/collections/task_entries/records") && method === "POST") return jsonResponse(200, { id: "te1" });
    if (url.includes("/api/collections/work_records/records") && method === "GET") return pageResponse([]);
    if (url.includes("/api/collections/work_records/records") && method === "POST") return jsonResponse(200, { id: "wr1" });
    return jsonResponse(404, { message: `unexpected ${method} ${url}` });
  }) as typeof fetch;
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

function tmpProjectDir(): string {
  const root = mkdtempSync(join(tmpdir(), "kankaku-cli-cli-sync-project-"));
  mkdirSync(join(root, ".kankaku"), { recursive: true });
  writeFileSync(join(root, ".kankaku", "worklog.jsonl"), `${fixtureLine("r1")}\n`);
  return root;
}

function tmpHomeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-cli-sync-home-"));
}

function baseDeps(homeDir: string, extra: Partial<Parameters<typeof runCli>[1]> = {}) {
  return {
    homeDir,
    cwd: homeDir,
    env: {},
    now: () => 1_000_000,
    stdout: () => {},
    stderr: () => {},
    exit: () => {},
    renderApp: () => {
      throw new Error("should not render the TUI");
    },
    ...extra,
  };
}

test("runCli 'sync status' without hub credentials prints a one-line note and exits 0", async () => {
  const homeDir = tmpHomeDir();
  const project = tmpProjectDir();
  try {
    const lines: string[] = [];
    let exitCode: number | undefined;
    await runCli(
      ["sync", "status", "--project", project],
      baseDeps(homeDir, { stdout: (text) => lines.push(text), exit: (code) => (exitCode = code) }),
    );
    assert.match(lines.join("\n"), /not configured/);
    assert.equal(exitCode, undefined);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("runCli 'sync' (no subcommand) without hub credentials prints an error and exits 1", async () => {
  const homeDir = tmpHomeDir();
  const project = tmpProjectDir();
  try {
    let stderrText = "";
    let exitCode: number | undefined;
    await runCli(["sync", "--project", project], baseDeps(homeDir, { stderr: (text) => (stderrText += text), exit: (code) => (exitCode = code) }));
    assert.match(stderrText, /not configured/);
    assert.equal(exitCode, 1);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("runCli 'sync status --project <dir>' with hub credentials reports the pending count, no network", async () => {
  const homeDir = tmpHomeDir();
  const project = tmpProjectDir();
  try {
    const lines: string[] = [];
    await runCli(
      ["sync", "status", "--project", project],
      baseDeps(homeDir, {
        env: { KANKAKU_PB_URL: "https://pb.example.com", KANKAKU_PB_EMAIL: "a@b.com", KANKAKU_PB_PASSWORD: "secret" },
        fetch: (() => {
          throw new Error("sync status must not touch the network");
        }) as unknown as typeof fetch,
        stdout: (text) => lines.push(text),
      }),
    );
    assert.match(lines.join("\n"), /pending: 1/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("runCli 'sync --project <dir>' with hub credentials uploads the pending task", async () => {
  const homeDir = tmpHomeDir();
  const project = tmpProjectDir();
  try {
    const lines: string[] = [];
    let exitCode: number | undefined;
    await runCli(
      ["sync", "--project", project],
      baseDeps(homeDir, {
        env: { KANKAKU_PB_URL: "https://pb.example.com", KANKAKU_PB_EMAIL: "a@b.com", KANKAKU_PB_PASSWORD: "secret" },
        fetch: fakeFetch(),
        stdout: (text) => lines.push(text),
        exit: (code) => (exitCode = code),
      }),
    );
    assert.match(lines.join("\n"), /uploaded 1/);
    assert.equal(exitCode, undefined);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
