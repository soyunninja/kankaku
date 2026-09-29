import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateHubPackage } from "../src/adapters/hub-manager/package.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-hub-package-"));
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const asset = { file: "pocketbase_0.40.4_darwin_arm64.zip", url: "https://example.test/pb.zip", sha256: "a".repeat(64) };
  return {
    name: "kankaku-hub",
    version: "0.2.0",
    schemaVersion: "sv1",
    migrations: ["m1"],
    pocketbase: {
      version: "0.40.4",
      assets: { "darwin-arm64": asset, "darwin-amd64": asset, "linux-arm64": asset, "linux-amd64": asset },
    },
    serve: { http: "127.0.0.1:8090", migrationsDir: "pocketbase/pb_migrations", hooksDir: "pocketbase/pb_hooks", publicDir: "public" },
    ...overrides,
  };
}

test("locateHubPackage: resolves the real installed kankaku-hub package and validates its manifest", () => {
  const result = locateHubPackage();
  assert.equal(result.manifest.name, "kankaku-hub");
  assert.equal(typeof result.dir, "string");
  assert.ok(result.dir.length > 0);
});

test("locateHubPackage: reads and validates the manifest next to a resolved package.json", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "kankaku-hub" }));
    writeFileSync(join(dir, "hub-manifest.json"), JSON.stringify(validManifest()));
    const result = locateHubPackage(() => join(dir, "package.json"));
    assert.equal(result.dir, dir);
    assert.equal(result.manifest.version, "0.2.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("locateHubPackage: throws a clear error when the package cannot be resolved", () => {
  assert.throws(
    () =>
      locateHubPackage(() => {
        throw new Error("Cannot find module 'kankaku-hub/package.json'");
      }),
    /kankaku-hub package is not installed/,
  );
});

test("locateHubPackage: throws when hub-manifest.json is missing", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "kankaku-hub" }));
    assert.throws(() => locateHubPackage(() => join(dir, "package.json")), /hub-manifest\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("locateHubPackage: throws when the manifest fails validation", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "kankaku-hub" }));
    writeFileSync(join(dir, "hub-manifest.json"), JSON.stringify(validManifest({ name: "wrong" })));
    assert.throws(() => locateHubPackage(() => join(dir, "package.json")), /invalid hub manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
