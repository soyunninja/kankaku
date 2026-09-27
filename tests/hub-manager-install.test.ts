import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHub, startHub, stopHub, hubStatus, upgradeHub, hubLogs } from "../src/adapters/hub-manager/install.ts";
import type { HubManagerDeps } from "../src/adapters/hub-manager/install.ts";
import { startDetached as realStartDetached } from "../src/adapters/hub-manager/process.ts";
import type { ScriptRunner, ScriptRunResult } from "../src/ports/script-runner.ts";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

function writeUint32LE(buf: number[], value: number): void {
  buf.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}
function writeUint16LE(buf: number[], value: number): void {
  buf.push(value & 0xff, (value >>> 8) & 0xff);
}

/** Builds a minimal, stored (uncompressed) single-entry zip, exactly like `hub-manager-download.test.ts`. */
function buildZip(entryName: string, content: Buffer): Buffer {
  const nameBytes = Buffer.from(entryName, "utf8");
  const data = content;

  const localHeader: number[] = [];
  writeUint32LE(localHeader, LOCAL_FILE_HEADER_SIGNATURE);
  writeUint16LE(localHeader, 20);
  writeUint16LE(localHeader, 0);
  writeUint16LE(localHeader, 0);
  writeUint16LE(localHeader, 0);
  writeUint16LE(localHeader, 0);
  writeUint32LE(localHeader, 0);
  writeUint32LE(localHeader, data.length);
  writeUint32LE(localHeader, content.length);
  writeUint16LE(localHeader, nameBytes.length);
  writeUint16LE(localHeader, 0);
  const localSection = Buffer.concat([Buffer.from(localHeader), nameBytes, data]);

  const centralHeader: number[] = [];
  writeUint32LE(centralHeader, CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16LE(centralHeader, 20);
  writeUint16LE(centralHeader, 20);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint32LE(centralHeader, 0);
  writeUint32LE(centralHeader, data.length);
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

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-hub-install-"));
}

function writePackage(dir: string, version: string, pocketbaseVersion: string, zip: Buffer): void {
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
    version,
    schemaVersion: "sv1",
    migrations: ["0001_init.js"],
    pocketbase: { version: pocketbaseVersion, assets: { "darwin-arm64": asset, "darwin-amd64": asset, "linux-arm64": asset, "linux-amd64": asset } },
    serve: { http: "127.0.0.1:8090", migrationsDir: "pocketbase/pb_migrations", hooksDir: "pocketbase/pb_hooks", publicDir: "public" },
  };
  writeFileSync(join(dir, "hub-manifest.json"), JSON.stringify(manifest));
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** A fake fetch serving the zip download, PocketBase health, and the accounts REST API. */
function fakeFetch(zip: Buffer): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (url.includes("pb.zip")) return new Response(new Uint8Array(zip), { status: 200 });
    if (url.endsWith("/api/health")) return new Response(null, { status: 200 });
    if (url.includes("_superusers/auth-with-password")) return new Response(JSON.stringify({ token: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("users/records?filter")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (url.includes("users/records") && init?.method === "POST") return new Response(JSON.stringify({ id: "u1" }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

interface RunnerCall {
  cmd: string;
  args: string[];
}

function fakeRunner(): { runner: ScriptRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: ScriptRunner = {
    async run(cmd, args) {
      calls.push({ cmd, args });
      const result: ScriptRunResult = { code: 0, stdout: "", stderr: "" };
      return result;
    },
    spawnDetached() {
      throw new Error("not used in install tests");
    },
  };
  return { runner, calls };
}

interface SpawnCall {
  binary: string;
  args: string[];
}

const spawnedPids: number[] = [];
process.on("exit", () => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

/**
 * Spawns a real, short-lived sleeper process (ignoring the given
 * binary/args, since the fake `hub-manifest.json` names no real
 * `pocketbase` binary) so `isAlive`/`stopProcess` observe a genuine
 * process instead of accidentally targeting the test runner's own pid.
 */
function fakeStartDetached(): { startDetached: HubManagerDeps["startDetached"]; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  return {
    startDetached: (binary, args, opts) => {
      calls.push({ binary, args });
      const pid = realStartDetached(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], opts);
      spawnedPids.push(pid);
      return pid;
    },
    calls,
  };
}

function baseDeps(homeDir: string, packageDir: string, zip: Buffer, overrides: Partial<HubManagerDeps> = {}): { deps: HubManagerDeps; fetchCalls: FetchCall[]; runnerCalls: RunnerCall[]; spawnCalls: SpawnCall[] } {
  const { fetch: doFetch, calls: fetchCalls } = fakeFetch(zip);
  const { runner, calls: runnerCalls } = fakeRunner();
  const { startDetached, calls: spawnCalls } = fakeStartDetached();
  const deps: HubManagerDeps = {
    homeDir,
    fetch: doFetch,
    runner,
    startDetached,
    sleep: async () => {},
    now: () => Date.parse("2026-09-28T00:00:00.000Z"),
    randomBytes: (n) => new Uint8Array(n).fill(7),
    locatePackage: () => ({ dir: packageDir, manifest: JSON.parse(readFileSync(join(packageDir, "hub-manifest.json"), "utf8")) }),
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  };
  return { deps, fetchCalls, runnerCalls, spawnCalls };
}

test("installHub: fresh install downloads pocketbase, copies app files, provisions accounts, and leaves the server running", async () => {
  const homeDir = makeDir();
  const packageDir = makeDir();
  try {
    const zip = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb\n"));
    writePackage(packageDir, "0.2.0", "0.40.4", zip);
    const { deps, spawnCalls } = baseDeps(homeDir, packageDir, zip);

    const report = await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, deps);

    assert.equal(report.ok, true);
    assert.equal(report.url, "http://127.0.0.1:8090");
    const outcomes = Object.fromEntries(report.steps.map((s) => [s.step, s.outcome]));
    assert.deepEqual(outcomes, {
      "create ~/.kankaku/hub": "done",
      "download pocketbase": "done",
      "install app files": "done",
      "write hub.json": "done",
      "provision accounts": "done",
    });

    assert.equal(existsSync(join(homeDir, ".kankaku", "hub", "bin", "pocketbase")), true);
    assert.equal(statSync(join(homeDir, ".kankaku", "hub", "bin", "pocketbase")).mode & 0o777, 0o755);
    assert.equal(existsSync(join(homeDir, ".kankaku", "hub", "app", "0.2.0", "pocketbase", "pb_migrations", "0001_init.js")), true);
    assert.equal(existsSync(join(homeDir, ".kankaku", "hub", "app", "0.2.0", "public", "index.html")), true);
    assert.equal(readFileSync(join(homeDir, ".kankaku", "hub", "current"), "utf8"), "0.2.0");

    const hubJson = JSON.parse(readFileSync(join(homeDir, ".kankaku", "hub", "hub.json"), "utf8"));
    assert.equal(hubJson.port, 8090);
    assert.equal(hubJson.appVersion, "0.2.0");
    assert.equal(hubJson.pocketbaseVersion, "0.40.4");

    const accounts = JSON.parse(readFileSync(join(homeDir, ".kankaku", "hub", "accounts.json"), "utf8"));
    assert.equal(accounts.ownerEmail, "owner@example.test");
    assert.equal(typeof accounts.superuserPassword, "string");
    assert.equal(statSync(join(homeDir, ".kankaku", "hub", "accounts.json")).mode & 0o777, 0o600);

    const credentials = JSON.parse(readFileSync(join(homeDir, ".kankaku", "credentials.json"), "utf8"));
    assert.equal(credentials.url, "http://127.0.0.1:8090");
    assert.equal(credentials.email, "kankaku-sync@kankaku.local");

    assert.equal(spawnCalls.length, 1); // the server is left running, never stopped by install
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("installHub: re-running with everything present reports every step unchanged and never re-provisions accounts", async () => {
  const homeDir = makeDir();
  const packageDir = makeDir();
  try {
    const zip = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb\n"));
    writePackage(packageDir, "0.2.0", "0.40.4", zip);
    const { deps: firstDeps } = baseDeps(homeDir, packageDir, zip);
    await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, firstDeps);

    const { deps: secondDeps, fetchCalls, runnerCalls, spawnCalls } = baseDeps(homeDir, packageDir, zip);
    const report = await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, secondDeps);

    assert.equal(report.ok, true);
    const outcomes = Object.fromEntries(report.steps.map((s) => [s.step, s.outcome]));
    assert.deepEqual(outcomes, {
      "create ~/.kankaku/hub": "unchanged",
      "download pocketbase": "unchanged",
      "install app files": "unchanged",
      "write hub.json": "unchanged",
      "provision accounts": "unchanged",
    });
    assert.equal(fetchCalls.length, 0);
    assert.equal(runnerCalls.length, 0);
    assert.equal(spawnCalls.length, 0);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("startHub/stopHub/hubStatus: not installed, then start/stop transitions after install", async () => {
  const homeDir = makeDir();
  const packageDir = makeDir();
  try {
    const zip = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb\n"));
    writePackage(packageDir, "0.2.0", "0.40.4", zip);

    const { deps: statusDeps } = baseDeps(homeDir, packageDir, zip);
    const notInstalled = await hubStatus(statusDeps);
    assert.deepEqual(notInstalled, { state: "not-installed" });

    const { deps: installDeps } = baseDeps(homeDir, packageDir, zip);
    await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, installDeps);

    // The pid file was left by install's own startDetached; hubStatus should report running.
    const { deps: statusDeps2 } = baseDeps(homeDir, packageDir, zip);
    const running = await hubStatus(statusDeps2);
    assert.equal(running.state, "running");
    assert.equal(running.url, "http://127.0.0.1:8090");

    const { deps: stopDeps } = baseDeps(homeDir, packageDir, zip);
    const stopReport = await stopHub(stopDeps);
    assert.equal(stopReport.steps[0]!.outcome, "done");
    assert.equal(existsSync(join(homeDir, ".kankaku", "hub", "pid")), false);

    const { deps: statusDeps3 } = baseDeps(homeDir, packageDir, zip);
    const stopped = await hubStatus(statusDeps3);
    assert.equal(stopped.state, "stopped");

    const { deps: startDeps, spawnCalls } = baseDeps(homeDir, packageDir, zip);
    const startReport = await startHub(startDeps);
    assert.equal(startReport.ok, true);
    assert.equal(startReport.steps[0]!.outcome, "done");
    assert.equal(spawnCalls.length, 1);

    const { deps: startAgainDeps, spawnCalls: spawnCallsAgain } = baseDeps(homeDir, packageDir, zip);
    const startAgainReport = await startHub(startAgainDeps);
    assert.equal(startAgainReport.steps[0]!.outcome, "unchanged");
    assert.equal(spawnCallsAgain.length, 0);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("upgradeHub: copies the new app version, downloads a new binary only if the pocketbase version changed, restarts, and keeps pb_data untouched", async () => {
  const homeDir = makeDir();
  const packageDir = makeDir();
  try {
    const zip1 = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb1\n"));
    writePackage(packageDir, "0.2.0", "0.40.4", zip1);
    const { deps: installDeps } = baseDeps(homeDir, packageDir, zip1);
    await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, installDeps);

    writeFileSync(join(homeDir, ".kankaku", "hub", "pb_data", "data.db"), "sentinel");

    const zip2 = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb2\n"));
    writePackage(packageDir, "0.3.0", "0.41.0", zip2);
    const { deps: upgradeDeps, spawnCalls } = baseDeps(homeDir, packageDir, zip2);
    const report = await upgradeHub(upgradeDeps);

    assert.equal(report.ok, true);
    const outcomes = Object.fromEntries(report.steps.map((s) => [s.step, s.outcome]));
    assert.equal(outcomes["install app files"], "done");
    assert.equal(outcomes["download pocketbase"], "done");
    assert.equal(existsSync(join(homeDir, ".kankaku", "hub", "app", "0.3.0", "public", "index.html")), true);
    assert.equal(readFileSync(join(homeDir, ".kankaku", "hub", "current"), "utf8"), "0.3.0");
    assert.equal(readFileSync(join(homeDir, ".kankaku", "hub", "pb_data", "data.db"), "utf8"), "sentinel");
    assert.equal(spawnCalls.length, 1);

    const hubJson = JSON.parse(readFileSync(join(homeDir, ".kankaku", "hub", "hub.json"), "utf8"));
    assert.equal(hubJson.appVersion, "0.3.0");
    assert.equal(hubJson.pocketbaseVersion, "0.41.0");

    const { deps: reUpgradeDeps } = baseDeps(homeDir, packageDir, zip2);
    const again = await upgradeHub(reUpgradeDeps);
    assert.equal(again.steps[0]!.outcome, "unchanged");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("hubLogs: returns the last n lines, oldest first, and [] when there is no log yet", () => {
  const homeDir = makeDir();
  try {
    assert.deepEqual(hubLogs(5, { homeDir }), []);
    mkdirSync(join(homeDir, ".kankaku", "hub"), { recursive: true });
    const logFile = join(homeDir, ".kankaku", "hub", "hub.log");
    for (let i = 1; i <= 5; i++) appendFileSync(logFile, `line ${i}\n`);
    assert.deepEqual(hubLogs(2, { homeDir }), ["line 4", "line 5"]);
    assert.deepEqual(hubLogs(100, { homeDir }), ["line 1", "line 2", "line 3", "line 4", "line 5"]);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
