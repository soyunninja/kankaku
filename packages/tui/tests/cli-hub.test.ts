import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.tsx";
import type { CliDeps } from "../src/cli.tsx";
import type { HubManagerDeps } from "../src/adapters/hub-manager/install.ts";
import type { ScriptRunner, ScriptRunResult } from "../src/ports/script-runner.ts";
import type { Prompter } from "../src/ports/prompter.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-cli-hub-home-"));
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

function writeUint32LE(buf: number[], value: number): void {
  buf.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}
function writeUint16LE(buf: number[], value: number): void {
  buf.push(value & 0xff, (value >>> 8) & 0xff);
}

/** A minimal, stored (uncompressed) single-entry zip, exactly like `hub-manager-install.test.ts`. */
function buildZip(entryName: string, content: Buffer): Buffer {
  const nameBytes = Buffer.from(entryName, "utf8");
  const localHeader: number[] = [];
  writeUint32LE(localHeader, LOCAL_FILE_HEADER_SIGNATURE);
  writeUint16LE(localHeader, 20);
  writeUint16LE(localHeader, 0);
  writeUint16LE(localHeader, 0);
  writeUint16LE(localHeader, 0);
  writeUint16LE(localHeader, 0);
  writeUint32LE(localHeader, 0);
  writeUint32LE(localHeader, content.length);
  writeUint32LE(localHeader, content.length);
  writeUint16LE(localHeader, nameBytes.length);
  writeUint16LE(localHeader, 0);
  const localSection = Buffer.concat([Buffer.from(localHeader), nameBytes, content]);

  const centralHeader: number[] = [];
  writeUint32LE(centralHeader, CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16LE(centralHeader, 20);
  writeUint16LE(centralHeader, 20);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint32LE(centralHeader, 0);
  writeUint32LE(centralHeader, content.length);
  writeUint32LE(centralHeader, content.length);
  writeUint16LE(centralHeader, nameBytes.length);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint32LE(centralHeader, 0);
  writeUint32LE(centralHeader, 0);
  const centralSection = Buffer.concat([Buffer.from(centralHeader), nameBytes]);
  const centralDirectoryOffset = localSection.length;

  const eocd: number[] = [];
  writeUint32LE(eocd, EOCD_SIGNATURE);
  writeUint16LE(eocd, 0);
  writeUint16LE(eocd, 0);
  writeUint16LE(eocd, 1);
  writeUint16LE(eocd, 1);
  writeUint32LE(eocd, centralSection.length);
  writeUint32LE(eocd, centralDirectoryOffset);
  writeUint16LE(eocd, 0);

  return Buffer.concat([localSection, centralSection, Buffer.from(eocd)]);
}

function makePackageDir(zip: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-tui-cli-hub-package-"));
  mkdirSync(join(dir, "pocketbase", "pb_migrations"), { recursive: true });
  mkdirSync(join(dir, "pocketbase", "pb_hooks"), { recursive: true });
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "pocketbase", "pb_migrations", "0001_init.js"), "// migration");
  writeFileSync(join(dir, "pocketbase", "pb_hooks", "hook.pb.js"), "// hook");
  writeFileSync(join(dir, "public", "index.html"), "<html></html>");

  const sha256 = createHash("sha256").update(zip).digest("hex");
  const asset = { file: "pocketbase.zip", url: "https://example.test/pb.zip", sha256 };
  const manifest = {
    name: "kankaku-hub",
    version: "0.2.0",
    schemaVersion: "sv1",
    migrations: ["0001_init.js"],
    pocketbase: { version: "0.40.4", assets: { "darwin-arm64": asset, "darwin-amd64": asset, "linux-arm64": asset, "linux-amd64": asset } },
    serve: { http: "127.0.0.1:8090", migrationsDir: "pocketbase/pb_migrations", hooksDir: "pocketbase/pb_hooks", publicDir: "public" },
  };
  writeFileSync(join(dir, "hub-manifest.json"), JSON.stringify(manifest));
  return dir;
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** Shared with `fakeHubManager`'s `startDetached`: `/api/health` only answers once the fake hub has "spawned", so the pre-spawn port-availability check genuinely sees the port as free. */
interface ServerState {
  listening: boolean;
}

function fakeFetch(zip: Buffer, state: ServerState): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("pb.zip")) return new Response(new Uint8Array(zip), { status: 200 });
    if (url.endsWith("/api/health")) {
      if (!state.listening) throw new Error("ECONNREFUSED");
      return new Response(null, { status: 200 });
    }
    if (url.includes("_superusers/auth-with-password")) return new Response(JSON.stringify({ token: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("users/records?filter")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (url.includes("users/records") && init?.method === "POST") return new Response(JSON.stringify({ id: "u1" }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function fakeRunner(): ScriptRunner {
  return {
    async run(): Promise<ScriptRunResult> {
      return { code: 0, stdout: "", stderr: "" };
    },
    spawnDetached() {
      throw new Error("not used in these tests");
    },
  };
}

let nextFakePid = 55000;

function fakeHubManager(packageDir: string, zip: Buffer, state: ServerState): Partial<HubManagerDeps> {
  return {
    runner: fakeRunner(),
    startDetached: (_binary, _args, opts) => {
      const pid = (nextFakePid += 1);
      writeFileSync(opts.pidFile, String(pid));
      state.listening = true;
      return pid;
    },
    sleep: async () => {},
    randomBytes: (n) => new Uint8Array(n).fill(9),
    locatePackage: () => ({ dir: packageDir, manifest: JSON.parse(readFileSync(join(packageDir, "hub-manifest.json"), "utf8")) }),
    platform: "darwin",
    arch: "arm64",
    isAlive: () => false, // the fake pid never corresponds to a real process
  };
}

function baseDeps(home: string, overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    homeDir: home,
    cwd: join(home, "project"),
    env: {},
    stdout: () => {},
    stderr: () => {},
    exit: () => {},
    renderApp: () => {
      throw new Error("should not render the TUI");
    },
    ...overrides,
  };
}

test("hub install: with flags, runs every step and prints the result", async () => {
  const home = makeHome();
  const zip = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb\n"));
  const packageDir = makePackageDir(zip);
  try {
    const lines: string[] = [];
    let exitCode: number | undefined;
    const state: ServerState = { listening: false };
    await runCli(
      ["hub", "install", "--owner-email", "owner@example.test", "--owner-password", "s3cret"],
      baseDeps(home, { fetch: fakeFetch(zip, state), hubManager: fakeHubManager(packageDir, zip, state), stdout: (text) => lines.push(text), exit: (code) => (exitCode = code) }),
    );

    assert.equal(exitCode, undefined);
    const output = lines.join("\n");
    assert.match(output, /^create ~\/\.kankaku\/hub: done$/m);
    assert.match(output, /^provision accounts: done/m);
    assert.match(output, /^hub running at http:\/\/127\.0\.0\.1:8090$/m);
    assert.equal(existsSync(join(home, ".kankaku", "hub", "accounts.json")), true);
    assert.equal(existsSync(join(home, ".kankaku", "credentials.json")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("hub install: on a TTY without flags, prompts for owner email/password", async () => {
  const home = makeHome();
  const zip = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb\n"));
  const packageDir = makePackageDir(zip);
  try {
    const prompts: string[] = [];
    const prompter: Prompter = {
      confirm: async () => true,
      text: async (question) => {
        prompts.push(question);
        return "owner@example.test";
      },
      secret: async (question) => {
        prompts.push(question);
        return "s3cret";
      },
    };
    let exitCode: number | undefined;
    const state: ServerState = { listening: false };
    await runCli(
      ["hub", "install"],
      baseDeps(home, {
        fetch: fakeFetch(zip, state),
        hubManager: fakeHubManager(packageDir, zip, state),
        isTTY: () => true,
        prompter,
        exit: (code) => (exitCode = code),
      }),
    );
    assert.equal(exitCode, undefined);
    assert.equal(prompts.length, 2);
    assert.equal(existsSync(join(home, ".kankaku", "hub", "accounts.json")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("hub install: without a TTY and missing flags, errors and exits 1 without installing anything", async () => {
  const home = makeHome();
  try {
    const errors: string[] = [];
    let exitCode: number | undefined;
    await runCli(["hub", "install"], baseDeps(home, { stderr: (text) => errors.push(text), exit: (code) => (exitCode = code) }));
    assert.equal(exitCode, 1);
    assert.match(errors.join(""), /--owner-email and --owner-password are required/);
    assert.equal(existsSync(join(home, ".kankaku", "hub")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hub status: not installed", async () => {
  const home = makeHome();
  try {
    const lines: string[] = [];
    await runCli(["hub", "status"], baseDeps(home, { stdout: (text) => lines.push(text) }));
    assert.deepEqual(lines, ["local hub: not installed"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hub logs: 'no logs yet' before anything has ever run", async () => {
  const home = makeHome();
  try {
    const lines: string[] = [];
    await runCli(["hub", "logs"], baseDeps(home, { stdout: (text) => lines.push(text) }));
    assert.deepEqual(lines, ["no logs yet"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hub: an unknown subcommand prints usage and exits 1", async () => {
  const home = makeHome();
  try {
    const errors: string[] = [];
    let exitCode: number | undefined;
    await runCli(["hub", "frobnicate"], baseDeps(home, { stderr: (text) => errors.push(text), exit: (code) => (exitCode = code) }));
    assert.equal(exitCode, 1);
    assert.match(errors.join(""), /^usage: kankaku /);
    assert.match(errors.join(""), /hub install/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hub --help (no subcommand at all still reaches the App); the usage line documents every hub subcommand", async () => {
  const home = makeHome();
  try {
    const errors: string[] = [];
    let exitCode: number | undefined;
    await runCli(["not-a-real-command"], baseDeps(home, { stderr: (text) => errors.push(text), exit: (code) => (exitCode = code) }));
    assert.equal(exitCode, 1);
    const usage = errors.join("");
    assert.match(usage, /hub install \[--port N\] \[--owner-email E\] \[--owner-password P\]/);
    assert.match(usage, /hub start/);
    assert.match(usage, /hub stop/);
    assert.match(usage, /hub status/);
    assert.match(usage, /hub upgrade/);
    assert.match(usage, /hub logs \[-n N\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
