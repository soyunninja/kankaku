/**
 * Runs the ACTUAL command `kankaku setup` writes into
 * `~/.claude/settings.json` for a SessionStart hook: `node
 * "<root>/dist/hook.js"`, against the real workspace `kankaku-claude`
 * package root, with an isolated HOME and a temp cwd, feeding a real
 * SessionStart hook payload on stdin. This is the test that would have
 * caught the original defect: kankaku-claude published/installed `.ts`
 * sources under `node_modules`, and Node 24 refuses to type-strip a `.ts`
 * file there (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — an error
 * `locateClaudePlugin`/unit tests never exercised because they only ever
 * imported `../src/*.ts` directly, never spawned the compiled command as
 * a real child process the way Claude Code itself does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require_ = createRequire(import.meta.url);

/** The monorepo root (three levels up from this file: tests -> tui -> packages -> root). */
const REPO_ROOT = new URL("../../..", import.meta.url).pathname;

function resolveClaudeClaudePackageRoot(): string | undefined {
  try {
    return dirname(require_.resolve("kankaku-claude/package.json"));
  } catch {
    return undefined;
  }
}

/** Builds kankaku-claude (`npm run build -w kankaku-claude`) from the repo root, tolerating any output. */
function buildKankakuClaude(): boolean {
  try {
    execFileSync("npm", ["run", "build", "-w", "kankaku-claude"], { cwd: REPO_ROOT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

test("node <workspace kankaku-claude root>/dist/hook.js exits 0 for a real SessionStart payload (the exact command kankaku setup writes)", async (t) => {
  const pluginRoot = resolveClaudeClaudePackageRoot();
  if (pluginRoot === undefined) {
    t.skip("kankaku-claude is not resolvable from kankaku-tui's node_modules; run npm install at the repo root first.");
    return;
  }

  const hookPath = join(pluginRoot, "dist", "hook.js");
  if (!existsSync(hookPath)) {
    const built = buildKankakuClaude();
    if (!built || !existsSync(hookPath)) {
      t.skip(`dist/hook.js is missing at ${hookPath} and could not be built automatically; run "npm run build -w kankaku-claude" at the repo root first.`);
      return;
    }
  }

  const homeDir = mkdtempSync(join(tmpdir(), "kankaku-tui-hook-integration-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "kankaku-tui-hook-integration-cwd-"));
  try {
    mkdirSync(cwd, { recursive: true });
    const payload = JSON.stringify({ session_id: "t", hook_event_name: "SessionStart", cwd, source: "startup" });

    const result = spawnSync("node", [hookPath], {
      cwd,
      env: { ...process.env, HOME: homeDir, KANKAKU_DIR: ".kankaku" },
      input: payload,
      encoding: "utf8",
      timeout: 15_000,
    });

    assert.equal(
      result.status,
      0,
      `expected exit code 0, got ${result.status} (signal ${result.signal}); stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
    assert.equal(result.stdout, "", "a hook must always print nothing on stdout");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
