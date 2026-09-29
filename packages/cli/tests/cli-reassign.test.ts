import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reassignScreenDeps } from "../src/cli.tsx";
import type { CliDeps } from "../src/cli.tsx";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-cli-reassign-home-"));
}

function baseDeps(home: string, overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    homeDir: home,
    cwd: join(home, "project"),
    env: {},
    now: () => 1000,
    stdout: () => {},
    stderr: () => {},
    exit: () => {},
    renderApp: () => {},
    ...overrides,
  };
}

function writeCredentials(home: string): void {
  mkdirSync(join(home, ".kankaku"), { recursive: true });
  writeFileSync(join(home, ".kankaku", "credentials.json"), JSON.stringify({ url: "https://hub.test", email: "svc@x", password: "pw" }));
}

test("reassignScreenDeps: without hub credentials, prepare reports why and apply does nothing", async () => {
  const home = makeHome();
  try {
    const actions = reassignScreenDeps(baseDeps(home));
    const prepared = await actions.prepare(["t1"]);
    assert.equal(prepared.ok, false);
    assert.match(prepared.ok ? "" : prepared.message, /hub credentials are not configured/);
    assert.deepEqual(await actions.apply({ mode: "single", destination: "Acme", lines: [] }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reassignScreenDeps: with credentials, prepare goes through the injected fetch, never the network", async () => {
  const home = makeHome();
  try {
    writeCredentials(home);
    const urls: string[] = [];
    const fetchStub = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ message: "no" }), { status: 401, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const actions = reassignScreenDeps(baseDeps(home, { fetch: fetchStub }));
    const prepared = await actions.prepare(["t1"]);
    assert.deepEqual(prepared, { ok: false, message: "the hub rejected the credentials" });
    assert.ok(urls.every((url) => url.startsWith("https://hub.test/")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
