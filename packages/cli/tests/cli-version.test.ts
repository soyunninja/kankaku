import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.tsx";
import type { CliDeps } from "../src/cli.tsx";
import { readCarriedVersions } from "../src/adapters/package-versions.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const ownVersion = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;

function baseDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    homeDir: "/nonexistent-home",
    cwd: "/nonexistent-cwd",
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

async function run(args: string[], overrides: Partial<CliDeps> = {}): Promise<{ out: string; err: string; exitCodes: number[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const exitCodes: number[] = [];
  await runCli(args, baseDeps({ stdout: (text) => out.push(text), stderr: (text) => err.push(text), exit: (code) => exitCodes.push(code), ...overrides }));
  return { out: out.join("\n"), err: err.join(""), exitCodes };
}

test("--version, -v and version print `kankaku <version>` then the carried packages' versions, to stdout, without failing", async () => {
  const expected = ["kankaku " + ownVersion, ...readCarriedVersions().map(({ name, version }) => `  ${name} ${version}`)].join("\n");
  for (const args of [["--version"], ["-v"], ["version"]]) {
    const result = await run(args);
    assert.equal(result.out, expected, args.join(" "));
    assert.equal(result.err, "", args.join(" "));
    assert.deepEqual(result.exitCodes, [], args.join(" "));
  }
});

test("version: a carried package that cannot be resolved prints `not found` and does not fail the command", async () => {
  const result = await run(["--version"], {
    resolvePackage: (specifier) => {
      if (specifier.startsWith("kankaku-claude")) throw new Error("Cannot find module");
      return join(repoRoot, "..", "pi", "package.json");
    },
  });
  const lines = result.out.split("\n");
  assert.equal(lines[0], `kankaku ${ownVersion}`);
  assert.equal(lines[2], "  kankaku-claude not found");
  assert.match(lines[1]!, /^ {2}kankaku-pi \d+\.\d+\.\d+/);
  assert.deepEqual(result.exitCodes, []);
});

test("the usage text documents the version command", async () => {
  const result = await run(["not-a-real-command"]);
  assert.match(result.err, /--version\|-v\|version/);
});

test("real spawn: `--version` prints the versions and exits 0", () => {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.tsx", "--version"], { cwd: repoRoot, encoding: "utf8" });
  assert.match(output, new RegExp(`^kankaku ${ownVersion.replaceAll(".", "\\.")}\\n {2}kankaku-pi \\d+\\.\\d+\\.\\d+\\n {2}kankaku-claude \\d+\\.\\d+\\.\\d+\\n {2}kankaku-hub \\d+\\.\\d+\\.\\d+\\n$`));
});

test("real spawn through a symlink (how npm's bin/kankaku runs it) prints the versions too", () => {
  const linkDir = mkdtempSync(join(tmpdir(), "kankaku-bin-version-"));
  const link = join(linkDir, "kankaku");
  symlinkSync(join(repoRoot, "src", "cli.tsx"), link);
  try {
    const output = execFileSync("node", ["--import", "tsx", link, "-v"], { cwd: repoRoot, encoding: "utf8" });
    assert.match(output, new RegExp(`^kankaku ${ownVersion.replaceAll(".", "\\.")}\\n`));
    assert.match(output, /kankaku-hub \d+\.\d+\.\d+/);
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }
});
