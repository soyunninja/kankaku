import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(cliDir, "scripts", "vendor-pi.mjs");

function runScript(script: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

/** A minimal monorepo: `<root>/cli/scripts/vendor-pi.mjs` next to `<root>/pi/{src,package.json,LICENSE}`. */
function fakeLayout(withExtension = true): { root: string; cli: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), "kankaku-vendor-pi-"));
  mkdirSync(join(root, "cli", "scripts"), { recursive: true });
  mkdirSync(join(root, "pi", "src", "domain"), { recursive: true });
  cpSync(scriptPath, join(root, "cli", "scripts", "vendor-pi.mjs"));
  if (withExtension) writeFileSync(join(root, "pi", "src", "extension.ts"), "export default 1;\n");
  writeFileSync(join(root, "pi", "src", "domain", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "pi", "package.json"), JSON.stringify({ name: "kankaku-pi", version: "9.9.9", type: "module" }));
  writeFileSync(join(root, "pi", "LICENSE"), "MIT\n");
  writeFileSync(join(root, "pi", "README.md"), "not vendored\n");
  return { root, cli: join(root, "cli"), script: join(root, "cli", "scripts", "vendor-pi.mjs") };
}

test("vendor-pi: copies src/, package.json and LICENSE into vendor/kankaku-pi and nothing else", () => {
  const { root, cli, script } = fakeLayout();
  try {
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    const out = join(cli, "vendor", "kankaku-pi");
    assert.equal(readFileSync(join(out, "src", "extension.ts"), "utf8"), "export default 1;\n");
    assert.equal(readFileSync(join(out, "src", "domain", "a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(JSON.parse(readFileSync(join(out, "package.json"), "utf8")).name, "kankaku-pi");
    assert.equal(readFileSync(join(out, "LICENSE"), "utf8"), "MIT\n");
    assert.equal(existsSync(join(out, "README.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vendor-pi: is idempotent and drops files that no longer exist in the source", () => {
  const { root, cli, script } = fakeLayout();
  try {
    assert.equal(runScript(script).status, 0);
    const out = join(cli, "vendor", "kankaku-pi");
    writeFileSync(join(out, "src", "stale.ts"), "stale\n");
    assert.equal(runScript(script).status, 0);
    assert.equal(existsSync(join(out, "src", "stale.ts")), false);
    assert.equal(readFileSync(join(out, "src", "extension.ts"), "utf8"), "export default 1;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vendor-pi: fails loudly when packages/pi/src/extension.ts is missing", () => {
  const { root, script } = fakeLayout(false);
  try {
    const result = runScript(script);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /extension\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vendor-pi: outside the monorepo (no sibling pi package) exits 0 and leaves an existing vendor/ untouched", () => {
  const { root, cli, script } = fakeLayout();
  try {
    rmSync(join(root, "pi"), { recursive: true });
    const marker = join(cli, "vendor", "kankaku-pi", "src", "extension.ts");
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "already vendored\n");
    const result = runScript(script);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(marker, "utf8"), "already vendored\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vendor-pi: --out <dir> and KANKAKU_VENDOR_OUT redirect the output away from vendor/", () => {
  const { root, cli, script } = fakeLayout();
  try {
    assert.equal(runScript(script, ["--out", join(root, "o1")]).status, 0);
    assert.equal(existsSync(join(root, "o1", "src", "extension.ts")), true);
    assert.equal(runScript(script, [], { KANKAKU_VENDOR_OUT: join(root, "o2") }).status, 0);
    assert.equal(existsSync(join(root, "o2", "src", "extension.ts")), true);
    assert.equal(existsSync(join(cli, "vendor")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest: every pi.extensions path lives under ./vendor/kankaku-pi/ and resolves next to a kankaku-pi package.json", () => {
  const manifest = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
  const extensions: string[] = manifest.pi?.extensions ?? [];
  assert.ok(extensions.length > 0, "pi.extensions must be declared");
  assert.ok(manifest.keywords.includes("pi-package"));
  for (const entry of extensions) assert.ok(entry.startsWith("./vendor/kankaku-pi/"), entry);

  const out = mkdtempSync(join(tmpdir(), "kankaku-vendor-real-"));
  try {
    const result = runScript(scriptPath, ["--out", join(out, "vendor", "kankaku-pi")]);
    assert.equal(result.status, 0, result.stderr);
    for (const entry of extensions) {
      const file = join(out, entry.slice(2));
      assert.equal(existsSync(file), true, entry);
      const pkg = JSON.parse(readFileSync(join(dirname(file), "..", "package.json"), "utf8"));
      assert.equal(pkg.name, "kankaku-pi");
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("manifest: files ships vendor/, dist/, README and LICENSE, and prepack runs the vendor script", () => {
  const manifest = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
  for (const entry of ["vendor/", "dist/", "README.md", "LICENSE"]) assert.ok(manifest.files.includes(entry), entry);
  assert.equal(manifest.scripts.prepack, "node scripts/vendor-pi.mjs");
  assert.ok(manifest.scripts.prepublishOnly);
});

test("packed tarball: npm pack (with prepack) lists the vendored extension and its package.json", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts=false"], { cwd: cliDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const files: string[] = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path);
  assert.ok(files.includes("vendor/kankaku-pi/src/extension.ts"), "extension.ts missing from the tarball");
  assert.ok(files.includes("vendor/kankaku-pi/package.json"), "package.json missing from the tarball");
  assert.ok(files.includes("vendor/kankaku-pi/LICENSE"));
  assert.ok(files.includes("dist/cli.js"));
});
