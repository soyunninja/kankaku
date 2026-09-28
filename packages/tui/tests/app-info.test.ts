import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppVersion, readOwnVersion } from "../src/adapters/app-info.ts";

test("readAppVersion reads the `version` field from <root>/package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-tui-app-info-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
  assert.equal(readAppVersion(dir), "9.9.9");
});

test("readAppVersion falls back to 0.0.0 when the field is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-tui-app-info-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
  assert.equal(readAppVersion(dir), "0.0.0");
});

test("readOwnVersion reads this package's own package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(readOwnVersion(), pkg.version);
});
