import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatVersionLines } from "../src/domain/version-info.ts";
import { CARRIED_PACKAGES, readCarriedVersions } from "../src/adapters/package-versions.ts";

test("formatVersionLines: `kankaku <version>` then one indented line per carried package, `not found` for an unresolved one", () => {
  assert.deepEqual(
    formatVersionLines("1.1.0", [
      { name: "kankaku-pi", version: "1.1.0" },
      { name: "kankaku-claude", version: undefined },
      { name: "kankaku-hub", version: "0.2.0" },
    ]),
    ["kankaku 1.1.0", "  kankaku-pi 1.1.0", "  kankaku-claude not found", "  kankaku-hub 0.2.0"],
  );
});

test("CARRIED_PACKAGES: the three packages kankaku carries, in order", () => {
  assert.deepEqual([...CARRIED_PACKAGES], ["kankaku-pi", "kankaku-claude", "kankaku-hub"]);
});

function writePackageJson(root: string, name: string, content: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "package.json");
  writeFileSync(file, content);
  return file;
}

test("readCarriedVersions: reads each package's version through the resolver; a missing, malformed or versionless package reads as undefined without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "kankaku-cli-versions-"));
  try {
    const files: Record<string, string> = {
      "kankaku-pi/package.json": writePackageJson(root, "kankaku-pi", JSON.stringify({ name: "kankaku-pi", version: "1.2.3" })),
      "kankaku-claude/package.json": writePackageJson(root, "kankaku-claude", "{nope"),
      "kankaku-hub/package.json": writePackageJson(root, "kankaku-hub", JSON.stringify({ name: "kankaku-hub" })),
    };
    const resolve = (specifier: string): string => {
      const file = files[specifier];
      if (!file) throw new Error(`Cannot find module '${specifier}'`);
      return file;
    };

    assert.deepEqual(readCarriedVersions(resolve), [
      { name: "kankaku-pi", version: "1.2.3" },
      { name: "kankaku-claude", version: undefined },
      { name: "kankaku-hub", version: undefined },
    ]);

    assert.deepEqual(
      readCarriedVersions(() => {
        throw new Error("Cannot find module");
      }),
      CARRIED_PACKAGES.map((name) => ({ name, version: undefined })),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCarriedVersions: the real resolution finds all three packages in this workspace", () => {
  const versions = readCarriedVersions();
  assert.equal(versions.length, 3);
  for (const { name, version } of versions) assert.match(version ?? "", /^\d+\.\d+\.\d+/, name);
});
