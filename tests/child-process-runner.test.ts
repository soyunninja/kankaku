import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildProcessRunner } from "../src/adapters/setup/child-process-runner.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-child-process-runner-"));
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200));
}

test("run: plumbs cmd/args/cwd and resolves stdout and a zero exit code", async () => {
  const dir = makeDir();
  try {
    const runner = createChildProcessRunner();
    const result = await runner.run(process.execPath, ["-e", "console.log('hi')"], { cwd: dir });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "hi");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: resolves a non-zero exit code and captures stderr", async () => {
  const dir = makeDir();
  try {
    const runner = createChildProcessRunner();
    const result = await runner.run(process.execPath, ["-e", "console.error('boom'); process.exit(3)"], { cwd: dir });
    assert.equal(result.code, 3);
    assert.equal(result.stderr.trim(), "boom");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnDetached: plumbs cmd/args/cwd/logFile, returning a live pid and writing output to the log file", async () => {
  const dir = makeDir();
  try {
    const runner = createChildProcessRunner();
    const logFile = join(dir, "out.log");
    const { pid } = runner.spawnDetached(process.execPath, ["-e", "console.log('from-detached')"], { cwd: dir, logFile });
    assert.equal(typeof pid, "number");
    assert.equal(pid > 0, true);

    await nextTick();
    assert.equal(existsSync(logFile), true);
    assert.equal(readFileSync(logFile, "utf8").includes("from-detached"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
