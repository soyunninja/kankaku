import assert from "node:assert/strict";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";

/**
 * Proves that `kankaku` publishes three compiled, pi-free public
 * entrypoints (`kankaku/domain`, `kankaku/ports`, `kankaku/hub`) that a
 * plain Node consumer — no TypeScript loader, no pi runtime — can import.
 * See odd/tasks/library-exports.md.
 */

const REPO_ROOT = join(import.meta.dirname, "..");
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

function runNpm(args: string[], cwd: string) {
  const result = spawnSync(NPM_COMMAND, args, { cwd, encoding: "utf8", timeout: 120_000 });
  return result;
}

function runNode(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 60_000 });
  return result;
}

function assertNoEarendilReferences(dir: string) {
  for (const entry of globSync(join(dir, "**", "*.js"))) {
    const contents = readFileSync(entry, "utf8");
    assert.ok(
      !contents.includes("@earendil-works"),
      `${entry} must not reference @earendil-works (public barrels must stay pi-free)`,
    );
  }
}

test("npm run build emits compiled output for the three public entrypoints", () => {
  const build = runNpm(["run", "build"], REPO_ROOT);
  assert.equal(build.status, 0, `npm run build must succeed: ${build.stdout}\n${build.stderr}`);

  for (const barrel of ["domain", "ports", "hub"]) {
    assert.ok(existsSync(join(REPO_ROOT, "dist", barrel, "index.js")), `dist/${barrel}/index.js must exist`);
    assert.ok(existsSync(join(REPO_ROOT, "dist", barrel, "index.d.ts")), `dist/${barrel}/index.d.ts must exist`);
  }
});

test("no file under dist/{domain,ports,hub} references @earendil-works", () => {
  assert.ok(existsSync(join(REPO_ROOT, "dist")), "dist must exist (run after the build test)");
  for (const barrel of ["domain", "ports", "hub"]) {
    assertNoEarendilReferences(join(REPO_ROOT, "dist", barrel));
  }
});

test("a plain child node process (no TS loader) can import each dist barrel and finds key symbols", () => {
  const script = `
    const domain = await import(${JSON.stringify(join(REPO_ROOT, "dist", "domain", "index.js"))});
    if (typeof domain.WorkTracker !== "function") throw new Error("domain.WorkTracker missing");
    if (typeof domain.unionMs !== "function") throw new Error("domain.unionMs missing");
    if (typeof domain.buildTasks !== "function") throw new Error("domain.buildTasks missing");

    const ports = await import(${JSON.stringify(join(REPO_ROOT, "dist", "ports", "index.js"))});
    void ports;

    const hub = await import(${JSON.stringify(join(REPO_ROOT, "dist", "hub", "index.js"))});
    if (typeof hub.PocketBaseClient !== "function") throw new Error("hub.PocketBaseClient missing");
    if (typeof hub.runSync !== "function") throw new Error("hub.runSync missing");

    console.log("OK");
  `;
  const result = runNode(["--input-type=module", "-e", script], REPO_ROOT);
  assert.equal(result.status, 0, `child process import must succeed: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
});

test("package.json exports resolves kankaku/domain|ports|hub to compiled files", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    exports?: Record<string, { types?: string; import?: string } | string>;
  };
  assert.ok(pkg.exports, "package.json must declare an exports map");
  for (const barrel of ["domain", "ports", "hub"]) {
    const entry = pkg.exports![`./${barrel}`];
    assert.ok(entry && typeof entry === "object", `exports["./${barrel}"] must be an object with types/import`);
    const { types, import: imp } = entry as { types?: string; import?: string };
    assert.ok(types === `./dist/${barrel}/index.d.ts`, `exports["./${barrel}"].types must point at dist/${barrel}/index.d.ts`);
    assert.ok(imp === `./dist/${barrel}/index.js`, `exports["./${barrel}"].import must point at dist/${barrel}/index.js`);
    assert.ok(existsSync(join(REPO_ROOT, types!.slice(2))), `${types} must exist on disk`);
    assert.ok(existsSync(join(REPO_ROOT, imp!.slice(2))), `${imp} must exist on disk`);
  }
  assert.equal(pkg.exports!["./package.json"], "./package.json");
  assert.equal(pkg.exports!["./src/*"], "./src/*");
});

let scratchProjectDir: string | undefined;
let packDestDir: string | undefined;

after(() => {
  if (scratchProjectDir) rmSync(scratchProjectDir, { recursive: true, force: true });
  if (packDestDir) rmSync(packDestDir, { recursive: true, force: true });
});

test("acceptance: a scratch project that installed the packed tarball imports kankaku/domain and kankaku/hub with plain Node", () => {
  packDestDir = mkdtempSync(join(tmpdir(), "kankaku-pack-"));
  const pack = runNpm(["pack", "--pack-destination", packDestDir], REPO_ROOT);
  assert.equal(pack.status, 0, `npm pack must succeed: ${pack.stdout}\n${pack.stderr}`);
  const tarballName = pack.stdout.trim().split("\n").pop()!.trim();
  const tarballPath = join(packDestDir, tarballName);
  assert.ok(existsSync(tarballPath), `packed tarball ${tarballPath} must exist`);

  scratchProjectDir = mkdtempSync(join(tmpdir(), "kankaku-scratch-"));
  writeFileSync(
    join(scratchProjectDir, "package.json"),
    JSON.stringify({ name: "kankaku-scratch", version: "0.0.0", private: true, type: "module" }, null, 2),
  );

  const install = runNpm(["install", tarballPath, "--offline", "--no-audit", "--no-fund"], scratchProjectDir);
  assert.equal(install.status, 0, `npm install of the tarball must succeed offline: ${install.stdout}\n${install.stderr}`);

  const script = `
    const domain = await import("kankaku/domain");
    if (typeof domain.WorkTracker !== "function") throw new Error("domain.WorkTracker missing");
    if (typeof domain.unionMs !== "function") throw new Error("domain.unionMs missing");
    if (typeof domain.buildTasks !== "function") throw new Error("domain.buildTasks missing");

    const ports = await import("kankaku/ports");
    void ports;

    const hub = await import("kankaku/hub");
    if (typeof hub.PocketBaseClient !== "function") throw new Error("hub.PocketBaseClient missing");
    if (typeof hub.runSync !== "function") throw new Error("hub.runSync missing");

    console.log("OK");
  `;
  const result = runNode(["--input-type=module", "-e", script], scratchProjectDir);
  assert.equal(result.status, 0, `scratch-project import must succeed: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);

  const hubIndexPath = join(scratchProjectDir, "node_modules", "kankaku", "dist", "hub", "index.js");
  assert.ok(existsSync(hubIndexPath), `${hubIndexPath} must exist in the installed package`);
  assert.ok(
    !readFileSync(hubIndexPath, "utf8").includes("@earendil-works"),
    "installed dist/hub/index.js must not reference @earendil-works",
  );
});
