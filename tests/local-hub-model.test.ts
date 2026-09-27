import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHubManifest,
  assetKeyFor,
  hubLayout,
  serveArgs,
  parseHubConfig,
  classifyStatus,
  generatePassword,
} from "../src/domain/local-hub-model.ts";
import type { HubManifest, HubConfig } from "../src/domain/local-hub-model.ts";

function validAsset(overrides: Partial<{ file: string; url: string; sha256: string }> = {}) {
  return {
    file: "pocketbase_0.40.4_darwin_arm64.zip",
    url: "https://example.test/pocketbase_0.40.4_darwin_arm64.zip",
    sha256: "a".repeat(64),
    ...overrides,
  };
}

function validManifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: "kankaku-hub",
    version: "0.2.0",
    schemaVersion: "1758300021_viewer_role_and_write_rules.js",
    migrations: ["1758300001_users_role_field.js"],
    pocketbase: {
      version: "0.40.4",
      assets: {
        "darwin-arm64": validAsset(),
        "darwin-amd64": validAsset({ file: "pocketbase_0.40.4_darwin_amd64.zip" }),
        "linux-arm64": validAsset({ file: "pocketbase_0.40.4_linux_arm64.zip" }),
        "linux-amd64": validAsset({ file: "pocketbase_0.40.4_linux_amd64.zip" }),
      },
    },
    serve: {
      http: "127.0.0.1:8090",
      migrationsDir: "pocketbase/pb_migrations",
      hooksDir: "pocketbase/pb_hooks",
      publicDir: "public",
    },
    ...overrides,
  };
}

test("parseHubManifest: accepts a well-formed manifest", () => {
  const manifest = parseHubManifest(validManifest());
  assert.equal(manifest.name, "kankaku-hub");
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.pocketbase.version, "0.40.4");
  assert.equal(manifest.pocketbase.assets["darwin-arm64"].sha256, "a".repeat(64));
  assert.equal(manifest.serve.http, "127.0.0.1:8090");
});

test("parseHubManifest: rejects a wrong name", () => {
  assert.throws(() => parseHubManifest(validManifest({ name: "not-kankaku-hub" })), /name/);
});

test("parseHubManifest: rejects a missing/empty version", () => {
  assert.throws(() => parseHubManifest(validManifest({ version: "" })), /version/);
  assert.throws(() => parseHubManifest(validManifest({ version: undefined })), /version/);
});

test("parseHubManifest: rejects empty migrations", () => {
  assert.throws(() => parseHubManifest(validManifest({ migrations: [] })), /migrations/);
  assert.throws(() => parseHubManifest(validManifest({ migrations: "not-an-array" })), /migrations/);
});

test("parseHubManifest: rejects a missing pocketbase.version", () => {
  assert.throws(
    () => parseHubManifest(validManifest({ pocketbase: { version: "", assets: (validManifest() as { pocketbase: { assets: unknown } }).pocketbase.assets } })),
    /pocketbase\.version/,
  );
});

test("parseHubManifest: rejects a missing asset key", () => {
  const manifest = validManifest();
  const pocketbase = (manifest as { pocketbase: { assets: Record<string, unknown> } }).pocketbase;
  delete pocketbase.assets["linux-amd64"];
  assert.throws(() => parseHubManifest(manifest), /linux-amd64/);
});

test("parseHubManifest: rejects a non-hex64 sha256", () => {
  const manifest = validManifest();
  const pocketbase = (manifest as { pocketbase: { assets: Record<string, { sha256: string }> } }).pocketbase;
  pocketbase.assets["darwin-arm64"].sha256 = "not-hex";
  assert.throws(() => parseHubManifest(manifest), /sha256/);
});

test("parseHubManifest: rejects a missing serve field", () => {
  const manifest = validManifest();
  const serve = (manifest as { serve: Record<string, unknown> }).serve;
  delete serve["hooksDir"];
  assert.throws(() => parseHubManifest(manifest), /serve\.hooksDir/);
});

test("parseHubManifest: rejects a non-object input", () => {
  assert.throws(() => parseHubManifest(null), /manifest/);
  assert.throws(() => parseHubManifest("nope"), /manifest/);
});

test("assetKeyFor: maps darwin/arm64", () => {
  assert.equal(assetKeyFor("darwin", "arm64"), "darwin-arm64");
});

test("assetKeyFor: maps darwin/x64 to darwin-amd64", () => {
  assert.equal(assetKeyFor("darwin", "x64"), "darwin-amd64");
});

test("assetKeyFor: maps linux/arm64", () => {
  assert.equal(assetKeyFor("linux", "arm64"), "linux-arm64");
});

test("assetKeyFor: maps linux/x64 to linux-amd64", () => {
  assert.equal(assetKeyFor("linux", "x64"), "linux-amd64");
});

test("assetKeyFor: throws for an unsupported platform", () => {
  assert.throws(() => assetKeyFor("win32", "x64"), /unsupported platform win32\/x64: kankaku hub runs on macOS and Linux/);
});

test("assetKeyFor: throws for an unsupported arch on a supported platform", () => {
  assert.throws(() => assetKeyFor("linux", "ia32"), /unsupported platform linux\/ia32/);
});

test("hubLayout: builds every path under <homeDir>/.kankaku/hub", () => {
  const layout = hubLayout("/home/alice");
  assert.equal(layout.root, "/home/alice/.kankaku/hub");
  assert.equal(layout.bin, "/home/alice/.kankaku/hub/bin");
  assert.equal(layout.binary, "/home/alice/.kankaku/hub/bin/pocketbase");
  assert.equal(layout.pbData, "/home/alice/.kankaku/hub/pb_data");
  assert.equal(layout.appDir("0.2.0"), "/home/alice/.kankaku/hub/app/0.2.0");
  assert.equal(layout.currentFile, "/home/alice/.kankaku/hub/current");
  assert.equal(layout.hubJson, "/home/alice/.kankaku/hub/hub.json");
  assert.equal(layout.accountsJson, "/home/alice/.kankaku/hub/accounts.json");
  assert.equal(layout.pidFile, "/home/alice/.kankaku/hub/pid");
  assert.equal(layout.logFile, "/home/alice/.kankaku/hub/hub.log");
});

test("serveArgs: builds the pocketbase serve argv from the app dir", () => {
  const layout = hubLayout("/home/alice");
  const args = serveArgs(layout, "0.2.0", 8090);
  assert.deepEqual(args, [
    "serve",
    "--http",
    "127.0.0.1:8090",
    "--dir",
    "/home/alice/.kankaku/hub/pb_data",
    "--migrationsDir",
    "/home/alice/.kankaku/hub/app/0.2.0/pocketbase/pb_migrations",
    "--hooksDir",
    "/home/alice/.kankaku/hub/app/0.2.0/pocketbase/pb_hooks",
    "--publicDir",
    "/home/alice/.kankaku/hub/app/0.2.0/public",
  ]);
});

test("parseHubConfig: accepts a well-formed config", () => {
  const config = parseHubConfig({ port: 8090, appVersion: "0.2.0", pocketbaseVersion: "0.40.4", installedAt: "2026-09-27T00:00:00.000Z" });
  assert.deepEqual(config, { port: 8090, appVersion: "0.2.0", pocketbaseVersion: "0.40.4", installedAt: "2026-09-27T00:00:00.000Z" } satisfies HubConfig);
});

test("parseHubConfig: rejects a non-numeric port", () => {
  assert.throws(() => parseHubConfig({ port: "8090", appVersion: "0.2.0", pocketbaseVersion: "0.40.4", installedAt: "x" }), /port/);
});

test("parseHubConfig: rejects an empty appVersion", () => {
  assert.throws(() => parseHubConfig({ port: 8090, appVersion: "", pocketbaseVersion: "0.40.4", installedAt: "x" }), /appVersion/);
});

test("parseHubConfig: rejects a non-object input", () => {
  assert.throws(() => parseHubConfig(null), /config/);
});

test("classifyStatus: not installed", () => {
  assert.deepEqual(classifyStatus({ installed: false, pidAlive: false, health: "skipped" }), { state: "not-installed" });
});

test("classifyStatus: installed but not running is stopped", () => {
  const config: HubConfig = { port: 8090, appVersion: "0.2.0", pocketbaseVersion: "0.40.4", installedAt: "2026-09-27T00:00:00.000Z" };
  assert.deepEqual(classifyStatus({ installed: true, config, pidAlive: false, health: "skipped" }), { state: "stopped", version: "0.2.0" });
});

test("classifyStatus: installed, alive and healthy is running with a url", () => {
  const config: HubConfig = { port: 8090, appVersion: "0.2.0", pocketbaseVersion: "0.40.4", installedAt: "2026-09-27T00:00:00.000Z" };
  assert.deepEqual(classifyStatus({ installed: true, config, pidAlive: true, health: "ok" }), {
    state: "running",
    url: "http://127.0.0.1:8090",
    version: "0.2.0",
  });
});

test("classifyStatus: installed, alive but failed health is unhealthy", () => {
  const config: HubConfig = { port: 8090, appVersion: "0.2.0", pocketbaseVersion: "0.40.4", installedAt: "2026-09-27T00:00:00.000Z" };
  assert.deepEqual(classifyStatus({ installed: true, config, pidAlive: true, health: "failed" }), {
    state: "unhealthy",
    url: "http://127.0.0.1:8090",
    version: "0.2.0",
  });
});

test("classifyStatus: installed but no config on disk is not-installed", () => {
  assert.deepEqual(classifyStatus({ installed: true, pidAlive: false, health: "skipped" }), { state: "not-installed" });
});

test("generatePassword: default length is 24 and only uses the URL-safe alphabet", () => {
  const bytes = Uint8Array.from({ length: 24 }, (_, i) => i * 7);
  const password = generatePassword(() => bytes);
  assert.equal(password.length, 24);
  assert.match(password, /^[A-Za-z0-9_-]+$/);
});

test("generatePassword: is deterministic under an injected RNG", () => {
  const rng = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31) % 256);
  assert.equal(generatePassword(rng), generatePassword(rng));
});

test("generatePassword: honors a custom length", () => {
  const rng = (n: number) => Uint8Array.from({ length: n }, (_, i) => i);
  assert.equal(generatePassword(rng, 12).length, 12);
});
