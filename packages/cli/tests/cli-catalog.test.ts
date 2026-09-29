import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.tsx";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pageResponse(items: unknown[]): Response {
  return jsonResponse(200, { page: 1, perPage: 200, totalItems: items.length, totalPages: 1, items });
}

function fakeFetch(clients: unknown[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/collections/users/auth-with-password")) return jsonResponse(200, { token: "tok", record: { id: "u1" } });
    if (url.includes("/api/collections/clients/records")) return pageResponse(clients);
    if (url.includes("/api/collections/projects/records")) return pageResponse([]);
    if (url.includes("/api/collections/tasks/records")) return pageResponse([]);
    return jsonResponse(404, { message: `unexpected ${method} ${url}` });
  }) as typeof fetch;
}

function tmpHomeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-cli-catalog-home-"));
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

test("runCli 'catalog' without hub credentials prints a one-line note and exits 0", async () => {
  const homeDir = tmpHomeDir();
  try {
    const lines: string[] = [];
    let exitCode: number | undefined;
    await runCli(["catalog"], baseDeps(homeDir, { stdout: (text) => lines.push(text), exit: (code) => (exitCode = code) }));
    assert.match(lines.join("\n"), /not configured/);
    assert.equal(exitCode, undefined);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runCli 'catalog refresh' without hub credentials prints an error and exits 1", async () => {
  const homeDir = tmpHomeDir();
  try {
    let stderrText = "";
    let exitCode: number | undefined;
    await runCli(["catalog", "refresh"], baseDeps(homeDir, { stderr: (text) => (stderrText += text), exit: (code) => (exitCode = code) }));
    assert.match(stderrText, /not configured/);
    assert.equal(exitCode, 1);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runCli 'catalog refresh' with hub credentials fetches and reports client/project counts", async () => {
  const homeDir = tmpHomeDir();
  try {
    const lines: string[] = [];
    await runCli(
      ["catalog", "refresh"],
      baseDeps(homeDir, {
        env: { KANKAKU_PB_URL: "https://pb.example.com", KANKAKU_PB_EMAIL: "a@b.com", KANKAKU_PB_PASSWORD: "secret" },
        fetch: fakeFetch([{ id: "c1", name: "Acme", code: "acme", active: true }]),
        stdout: (text) => lines.push(text),
      }),
    );
    assert.match(lines.join("\n"), /refreshed: 1 client/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
