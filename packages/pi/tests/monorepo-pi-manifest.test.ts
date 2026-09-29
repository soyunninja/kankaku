import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `pi install git:github.com/soyunninja/kankaku` clones the REPOSITORY and
// reads the `pi` manifest of the package.json at its root. Since the
// repository became a monorepo that root is no longer this package, so the
// root must declare the extension itself or a git install loads nothing.

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(packageRoot, "..", "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function extensionsOf(manifest: Record<string, unknown>): string[] {
  const pi = manifest["pi"] as { extensions?: unknown } | undefined;
  return Array.isArray(pi?.extensions) ? (pi.extensions as string[]) : [];
}

test("the repository root declares this package's pi extension, so a git install loads it", { skip: !existsSync(join(repoRoot, "packages", "pi")) }, () => {
  const rootExtensions = extensionsOf(readJson(join(repoRoot, "package.json")));
  const ownExtensions = extensionsOf(readJson(join(packageRoot, "package.json")));

  assert.ok(ownExtensions.length > 0, "the package itself must declare its extension");
  const expected = ownExtensions.map((path) => resolve(packageRoot, path));
  const actual = rootExtensions.map((path) => resolve(repoRoot, path));

  assert.deepEqual(actual, expected, "the root manifest must point at exactly the package's own extension files");
  for (const file of actual) assert.ok(existsSync(file), `${file} must exist`);
});
