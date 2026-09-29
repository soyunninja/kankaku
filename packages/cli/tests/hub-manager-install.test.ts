import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHub, startHub, stopHub, hubStatus, upgradeHub, hubLogs } from "../src/adapters/hub-manager/install.ts";
import type { HubManagerDeps } from "../src/adapters/hub-manager/install.ts";
import { startDetached as realStartDetached, isAlive as realIsAlive } from "../src/adapters/hub-manager/process.ts";
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
  return mkdtempSync(join(tmpdir(), "kankaku-cli-hub-install-"));
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

/** Shared between a test's `fakeFetch` and `fakeStartDetached`: `/api/health` only answers once something has actually "started listening", exactly like a real PocketBase — a pre-spawn health probe must see nothing there. */
interface ServerState {
  listening: boolean;
}

/**
 * A fake fetch serving the zip download, PocketBase health, and the
 * accounts REST API. `/api/health` rejects (simulating `ECONNREFUSED`)
 * until `state.listening` is set, which `fakeStartDetached` does once it
 * spawns — so a pre-spawn port-availability probe genuinely sees the port
 * as free, and a post-spawn health poll genuinely sees it as up.
 */
function fakeFetch(zip: Buffer, state: ServerState): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
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
 * Flips `state.listening` to simulate the server coming up.
 */
function fakeStartDetached(state: ServerState): { startDetached: HubManagerDeps["startDetached"]; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  return {
    startDetached: (binary, args, opts) => {
      calls.push({ binary, args });
      const pid = realStartDetached(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], opts);
      spawnedPids.push(pid);
      state.listening = true;
      return pid;
    },
    calls,
  };
}

function baseDeps(
  homeDir: string,
  packageDir: string,
  zip: Buffer,
  overrides: Partial<HubManagerDeps> = {},
  state: ServerState = { listening: false },
): { deps: HubManagerDeps; fetchCalls: FetchCall[]; runnerCalls: RunnerCall[]; spawnCalls: SpawnCall[]; state: ServerState } {
  const { fetch: doFetch, calls: fetchCalls } = fakeFetch(zip, state);
  const { runner, calls: runnerCalls } = fakeRunner();
  const { startDetached, calls: spawnCalls } = fakeStartDetached(state);
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
    isAlive: (pid) => realIsAlive(pid),
    ...overrides,
  };
  return { deps, fetchCalls, runnerCalls, spawnCalls, state };
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
      "start hub": "done",
      "provision accounts": "done",
      "write service.json": "done",
      "sync credentials": "done",
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

    const serviceFile = join(homeDir, ".kankaku", "hub", "service.json");
    assert.equal(statSync(serviceFile).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(serviceFile, "utf8")), { url: "http://127.0.0.1:8090", email: credentials.email, password: credentials.password });

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
      "write service.json": "unchanged",
      "sync credentials": "unchanged",
    });
    assert.equal(fetchCalls.length, 0);
    assert.equal(runnerCalls.length, 0);
    assert.equal(spawnCalls.length, 0);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("installHub: refuses to provision accounts when another process already answers on the port, leaving no pid file and no accounts.json; retrying on a free --port then succeeds", async () => {
  const homeDir = makeDir();
  const packageDir = makeDir();
  try {
    const zip = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb\n"));
    writePackage(packageDir, "0.2.0", "0.40.4", zip);

    // A foreign PocketBase (or anything else) already listens on 8090: /api/health answers before we ever spawn.
    // The zip download and account-REST endpoints are still served normally (via `listening: true` from the
    // start) so the flow reaches the accounts-provisioning step exactly like the real bug report.
    const { runner: runner1, calls: runnerCalls1 } = fakeRunner();
    const { startDetached: startDetached1, calls: spawnCalls1 } = fakeStartDetached({ listening: false });
    const conflictingDeps: HubManagerDeps = {
      homeDir,
      fetch: fakeFetch(zip, { listening: true }).fetch,
      runner: runner1,
      startDetached: startDetached1,
      sleep: async () => {},
      now: () => Date.parse("2026-09-28T00:00:00.000Z"),
      randomBytes: (n) => new Uint8Array(n).fill(7),
      locatePackage: () => ({ dir: packageDir, manifest: JSON.parse(readFileSync(join(packageDir, "hub-manifest.json"), "utf8")) }),
      platform: "darwin",
      arch: "arm64",
      isAlive: () => false,
    };

    const report = await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, conflictingDeps);

    assert.equal(report.ok, false);
    const outcomes = Object.fromEntries(report.steps.map((s) => [s.step, s.outcome]));
    assert.equal(outcomes["write hub.json"], "done"); // the layout/config write already happened
    // The failure is the START, not the accounts: the accounts step never ran.
    assert.equal(outcomes["start hub"], "error");
    assert.equal(outcomes["provision accounts"], undefined);
    const failedStep = report.steps.find((s) => s.step === "start hub")!;
    assert.equal(failedStep.detail, "port 8090 is already in use by another process — pass --port <N> or stop it");

    assert.equal(existsSync(join(homeDir, ".kankaku", "hub", "accounts.json")), false);
    assert.equal(existsSync(join(homeDir, ".kankaku", "hub", "pid")), false);
    assert.equal(spawnCalls1.length, 0); // never spawned
    assert.equal(runnerCalls1.length, 0); // upsertSuperuser never ran

    const hubJsonAfterConflict = JSON.parse(readFileSync(join(homeDir, ".kankaku", "hub", "hub.json"), "utf8"));
    assert.equal(hubJsonAfterConflict.port, 8090);

    // Retrying with a free port succeeds: hub.json is rewritten, the hub starts on the new port, and accounts get provisioned.
    const { deps: retryDeps, spawnCalls: retrySpawnCalls } = baseDeps(homeDir, packageDir, zip);
    const retryReport = await installHub({ port: 8091, ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, retryDeps);

    assert.equal(retryReport.ok, true);
    assert.equal(retryReport.url, "http://127.0.0.1:8091");
    const retryOutcomes = Object.fromEntries(retryReport.steps.map((s) => [s.step, s.outcome]));
    assert.deepEqual(retryOutcomes, {
      "create ~/.kankaku/hub": "unchanged",
      "download pocketbase": "unchanged",
      "install app files": "unchanged",
      "write hub.json": "done",
      "start hub": "done",
      "provision accounts": "done",
      "write service.json": "done",
      "sync credentials": "done",
    });
    assert.equal(retrySpawnCalls.length, 1);

    const hubJsonAfterRetry = JSON.parse(readFileSync(join(homeDir, ".kankaku", "hub", "hub.json"), "utf8"));
    assert.equal(hubJsonAfterRetry.port, 8091);
    assert.equal(existsSync(join(homeDir, ".kankaku", "hub", "accounts.json")), true);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

const SERVICE_EMAIL = "kankaku-sync@kankaku.local";
const OTHER_HUB_CREDENTIALS = JSON.stringify({ url: "https://hub.example.com", email: "me@example.com", password: "real-hub-password" }, null, 2);

function credentialsPathFor(homeDir: string): string {
  return join(homeDir, ".kankaku", "credentials.json");
}

/** Writes `credentials.json` with a fixed, old mtime so a later rewrite is detectable. */
function seedCredentials(homeDir: string, body: string): number {
  mkdirSync(join(homeDir, ".kankaku"), { recursive: true });
  writeFileSync(credentialsPathFor(homeDir), body);
  const old = new Date("2026-01-01T00:00:00.000Z");
  utimesSync(credentialsPathFor(homeDir), old, old);
  return statSync(credentialsPathFor(homeDir)).mtimeMs;
}

test("installHub: credentials.json pointing at another hub is left byte-for-byte untouched; service.json still holds the local service account and the report says how to switch", async () => {
  const homeDir = makeDir();
  const packageDir = makeDir();
  try {
    const zip = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb\n"));
    writePackage(packageDir, "0.2.0", "0.40.4", zip);
    const mtimeBefore = seedCredentials(homeDir, OTHER_HUB_CREDENTIALS);
    const { deps } = baseDeps(homeDir, packageDir, zip);

    const report = await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, deps);

    assert.equal(report.ok, true);
    assert.equal(readFileSync(credentialsPathFor(homeDir), "utf8"), OTHER_HUB_CREDENTIALS);
    assert.equal(statSync(credentialsPathFor(homeDir)).mtimeMs, mtimeBefore);
    assert.equal(existsSync(`${credentialsPathFor(homeDir)}.bak`), false);

    const service = JSON.parse(readFileSync(join(homeDir, ".kankaku", "hub", "service.json"), "utf8"));
    assert.equal(service.url, "http://127.0.0.1:8090");
    assert.equal(service.email, SERVICE_EMAIL);
    assert.equal(typeof service.password, "string");

    const step = report.steps.find((s) => s.step === "sync credentials");
    assert.deepEqual(step, {
      step: "sync credentials",
      outcome: "unchanged",
      detail: "this machine syncs to https://hub.example.com; run 'kankaku hub use' to switch to the local hub",
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("installHub: credentials.json that already points at this local hub (same host and port) is rewritten with the service account", async () => {
  const homeDir = makeDir();
  const packageDir = makeDir();
  try {
    const zip = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb\n"));
    writePackage(packageDir, "0.2.0", "0.40.4", zip);
    seedCredentials(homeDir, JSON.stringify({ url: "http://localhost:8090", email: "old@example.test", password: "old" }));
    const { deps } = baseDeps(homeDir, packageDir, zip);

    const report = await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, deps);

    assert.equal(report.ok, true);
    const credentials = JSON.parse(readFileSync(credentialsPathFor(homeDir), "utf8"));
    assert.equal(credentials.url, "http://127.0.0.1:8090");
    assert.equal(credentials.email, SERVICE_EMAIL);
    assert.deepEqual(report.steps.find((s) => s.step === "sync credentials"), { step: "sync credentials", outcome: "done", detail: "points at http://127.0.0.1:8090" });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("installHub: with no credentials.json the fresh install writes one and says it points at the local hub", async () => {
  const homeDir = makeDir();
  const packageDir = makeDir();
  try {
    const zip = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb\n"));
    writePackage(packageDir, "0.2.0", "0.40.4", zip);
    const { deps } = baseDeps(homeDir, packageDir, zip);

    const report = await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, deps);

    assert.deepEqual(report.steps.find((s) => s.step === "sync credentials"), { step: "sync credentials", outcome: "done", detail: "points at http://127.0.0.1:8090" });
    assert.equal(statSync(credentialsPathFor(homeDir)).mode & 0o777, 0o600);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

/** Turns a finished install into what an older version left behind: no service.json. */
function makeLegacyInstall(homeDir: string): void {
  rmSync(join(homeDir, ".kankaku", "hub", "service.json"), { force: true });
}

test("installHub: re-run on an install made before service.json existed recovers the service account from a credentials.json that points at the local hub", async () => {
  const homeDir = makeDir();
  const packageDir = makeDir();
  try {
    const zip = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb\n"));
    writePackage(packageDir, "0.2.0", "0.40.4", zip);
    const { deps: firstDeps } = baseDeps(homeDir, packageDir, zip);
    await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, firstDeps);
    const original = JSON.parse(readFileSync(join(homeDir, ".kankaku", "hub", "service.json"), "utf8"));
    makeLegacyInstall(homeDir);

    const { deps } = baseDeps(homeDir, packageDir, zip);
    const report = await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, deps);

    assert.equal(report.ok, true);
    assert.equal(report.steps.find((s) => s.step === "write service.json")?.outcome, "done");
    assert.deepEqual(JSON.parse(readFileSync(join(homeDir, ".kankaku", "hub", "service.json"), "utf8")), original);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("installHub: re-run on an older install whose service password is nowhere to be found says so plainly, invents nothing and leaves credentials.json alone", async () => {
  const homeDir = makeDir();
  const packageDir = makeDir();
  try {
    const zip = buildZip("pocketbase", Buffer.from("#!/bin/sh\necho pb\n"));
    writePackage(packageDir, "0.2.0", "0.40.4", zip);
    const { deps: firstDeps } = baseDeps(homeDir, packageDir, zip);
    await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, firstDeps);
    makeLegacyInstall(homeDir);
    const mtimeBefore = seedCredentials(homeDir, OTHER_HUB_CREDENTIALS);

    const { deps } = baseDeps(homeDir, packageDir, zip);
    const report = await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, deps);

    assert.equal(report.ok, true);
    assert.equal(existsSync(join(homeDir, ".kankaku", "hub", "service.json")), false);
    const step = report.steps.find((s) => s.step === "write service.json");
    assert.equal(step?.outcome, "unchanged");
    assert.match(step?.detail ?? "", /not recoverable/);
    assert.equal(report.steps.some((s) => s.step === "sync credentials"), false);
    assert.equal(readFileSync(credentialsPathFor(homeDir), "utf8"), OTHER_HUB_CREDENTIALS);
    assert.equal(statSync(credentialsPathFor(homeDir)).mtimeMs, mtimeBefore);
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

    // One shared server state across every step below: it is the same
    // (fake) real hub process throughout, so a status check must see it
    // as up/down consistently with whatever the previous step just did.
    const state: ServerState = { listening: false };

    const { deps: statusDeps } = baseDeps(homeDir, packageDir, zip, {}, state);
    const notInstalled = await hubStatus(statusDeps);
    assert.deepEqual(notInstalled, { state: "not-installed" });

    const { deps: installDeps } = baseDeps(homeDir, packageDir, zip, {}, state);
    await installHub({ ownerEmail: "owner@example.test", ownerPassword: "s3cret" }, installDeps);

    // The pid file was left by install's own startDetached; hubStatus should report running.
    const { deps: statusDeps2 } = baseDeps(homeDir, packageDir, zip, {}, state);
    const running = await hubStatus(statusDeps2);
    assert.equal(running.state, "running");
    assert.equal(running.url, "http://127.0.0.1:8090");

    const { deps: stopDeps } = baseDeps(homeDir, packageDir, zip, {}, state);
    const stopReport = await stopHub(stopDeps);
    assert.equal(stopReport.steps[0]!.outcome, "done");
    assert.equal(existsSync(join(homeDir, ".kankaku", "hub", "pid")), false);
    state.listening = false; // the real process was just stopped

    const { deps: statusDeps3 } = baseDeps(homeDir, packageDir, zip, {}, state);
    const stopped = await hubStatus(statusDeps3);
    assert.equal(stopped.state, "stopped");

    const { deps: startDeps, spawnCalls } = baseDeps(homeDir, packageDir, zip, {}, state);
    const startReport = await startHub(startDeps);
    assert.equal(startReport.ok, true);
    assert.equal(startReport.steps[0]!.outcome, "done");
    assert.equal(spawnCalls.length, 1);

    const { deps: startAgainDeps, spawnCalls: spawnCallsAgain } = baseDeps(homeDir, packageDir, zip, {}, state);
    const startAgainReport = await startHub(startAgainDeps);
    assert.equal(startAgainReport.steps[0]!.outcome, "unchanged");
    assert.equal(spawnCallsAgain.length, 0);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("startHub: fails immediately, reporting the last hub.log line, and removes the stale pid file when the spawned process exits during startup", async () => {
  const homeDir = makeDir();
  try {
    mkdirSync(join(homeDir, ".kankaku", "hub"), { recursive: true });
    const hubJson = { port: 8090, appVersion: "0.2.0", pocketbaseVersion: "0.40.4", installedAt: "2026-09-27T00:00:00.000Z" };
    writeFileSync(join(homeDir, ".kankaku", "hub", "hub.json"), JSON.stringify(hubJson));

    const logFile = join(homeDir, ".kankaku", "hub", "hub.log");
    const pidFile = join(homeDir, ".kankaku", "hub", "pid");

    // A real, short-lived process that fails to bind and exits, writing the
    // exact error line a real PocketBase bind failure would produce.
    const failureLine = "listen tcp 127.0.0.1:8090: bind: address already in use";
    const startDetached: HubManagerDeps["startDetached"] = (_binary, _args, opts) => {
      const pid = realStartDetached(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(failureLine + "\n")}); process.exit(1);`], opts);
      spawnedPids.push(pid);
      return pid;
    };

    const deps: HubManagerDeps = {
      homeDir,
      fetch: (async () => {
        throw new Error("ECONNREFUSED"); // nothing ever comes up to listen
      }) as unknown as typeof fetch,
      runner: fakeRunner().runner,
      startDetached,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.parse("2026-09-28T00:00:00.000Z"),
      randomBytes: (n) => new Uint8Array(n).fill(7),
      locatePackage: () => {
        throw new Error("not used: hub.json is already installed");
      },
      platform: "darwin",
      arch: "arm64",
      isAlive: (pid) => realIsAlive(pid),
    };

    const startedAt = Date.now();
    const report = await startHub(deps);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(report.ok, false);
    assert.equal(report.steps[0]!.outcome, "error");
    assert.equal(report.steps[0]!.detail, `the hub exited during startup: ${failureLine}`);
    assert.equal(existsSync(pidFile), false); // no stale pid file left behind
    assert.equal(existsSync(logFile), true);
    assert.ok(elapsedMs < 10000, `expected the early exit to be fast, took ${elapsedMs}ms`); // well under the 20s health timeout
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("hubStatus: a dead pid is reported stopped even when another process now answers on the port", async () => {
  const homeDir = makeDir();
  try {
    mkdirSync(join(homeDir, ".kankaku", "hub"), { recursive: true });
    const hubJson = { port: 8090, appVersion: "0.2.0", pocketbaseVersion: "0.40.4", installedAt: "2026-09-27T00:00:00.000Z" };
    writeFileSync(join(homeDir, ".kankaku", "hub", "hub.json"), JSON.stringify(hubJson));
    writeFileSync(join(homeDir, ".kankaku", "hub", "pid"), "999999"); // very unlikely to be alive

    let healthCalls = 0;
    const deps: Pick<HubManagerDeps, "homeDir" | "fetch"> = {
      homeDir,
      fetch: (async () => {
        healthCalls += 1;
        return new Response(null, { status: 200 }); // a foreign process now answers here
      }) as typeof fetch,
    };

    const status = await hubStatus(deps);
    assert.deepEqual(status, { state: "stopped", version: "0.2.0" });
    assert.equal(healthCalls, 0); // health is never even checked once the pid is dead
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
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

test("upgradeHub: refuses to restart when another process now holds the port, and leaves pb_data untouched", async () => {
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

    // Another process takes over 8090 right after upgradeHub stops ours to restart. The zip
    // download still needs to work normally (the pocketbase version changed) so the flow reaches
    // the restart step, exactly like the real bug report.
    const { runner, calls: runnerCalls } = fakeRunner();
    const { startDetached, calls: spawnCalls } = fakeStartDetached({ listening: false });
    const upgradeDeps: HubManagerDeps = {
      homeDir,
      fetch: fakeFetch(zip2, { listening: true }).fetch,
      runner,
      startDetached,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.parse("2026-09-28T00:00:00.000Z"),
      randomBytes: (n) => new Uint8Array(n).fill(7),
      locatePackage: () => ({ dir: packageDir, manifest: JSON.parse(readFileSync(join(packageDir, "hub-manifest.json"), "utf8")) }),
      platform: "darwin",
      arch: "arm64",
      isAlive: (pid) => realIsAlive(pid),
    };

    const report = await upgradeHub(upgradeDeps);

    assert.equal(report.ok, false);
    const outcomes = Object.fromEntries(report.steps.map((s) => [s.step, s.outcome]));
    assert.equal(outcomes["install app files"], "done");
    assert.equal(outcomes["download pocketbase"], "done");
    assert.equal(outcomes["write hub.json"], "done");
    assert.equal(outcomes["restart"], "error");
    const restartStep = report.steps.find((s) => s.step === "restart")!;
    assert.equal(restartStep.detail, "port 8090 is already in use by another process — pass --port <N> or stop it");
    assert.equal(spawnCalls.length, 0);
    assert.equal(runnerCalls.length, 0);
    assert.equal(readFileSync(join(homeDir, ".kankaku", "hub", "pb_data", "data.db"), "utf8"), "sentinel");
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
