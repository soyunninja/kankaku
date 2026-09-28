import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.tsx";

function fixtureLine(id: string, day: string): string {
  return JSON.stringify({
    schema: 1,
    id,
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "demo",
    prompt: "hello",
    startedAt: `${day}T09:00:00.000Z`,
    settledAt: `${day}T09:01:00.000Z`,
    wallMs: 60000,
    waitingMs: 0,
    workMs: 60000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
    status: "completed",
  });
}

function makeProjectRoot(day: string): string {
  const root = mkdtempSync(join(tmpdir(), "kankaku-tui-cli-"));
  const project = join(root, "demo");
  mkdirSync(join(project, ".kankaku"), { recursive: true });
  writeFileSync(join(project, ".kankaku", "worklog.jsonl"), `${fixtureLine("r1", day)}\n`);
  return root;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

test("runCli 'today' prints one line per project to stdout", () => {
  const root = makeProjectRoot(today());
  try {
    const lines: string[] = [];
    let exitCode: number | undefined;
    runCli(["today", "--roots", root], {
      homeDir: root,
      cwd: root,
      stdout: (text) => lines.push(text),
      stderr: () => {},
      exit: (code) => {
        exitCode = code;
      },
      renderApp: () => {
        throw new Error("should not render the TUI for 'today'");
      },
    });
    assert.equal(exitCode, undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^demo\s+tasks 1/);
    assert.match(lines[0]!, /total\s+tasks 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCli with no subcommand renders the Ink app", () => {
  const root = makeProjectRoot(today());
  try {
    let rendered: string[] | undefined;
    runCli([], {
      homeDir: root,
      cwd: root,
      stdout: () => {},
      stderr: () => {},
      exit: () => {},
      renderApp: (roots) => {
        rendered = roots;
      },
    });
    assert.deepEqual(rendered, [root]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCli reports usage and exits 1 for an unknown subcommand", () => {
  let stderrText = "";
  let exitCode: number | undefined;
  runCli(["bogus"], {
    homeDir: "/tmp",
    cwd: "/tmp",
    stdout: () => {},
    stderr: (text) => (stderrText += text),
    exit: (code) => {
      exitCode = code;
    },
    renderApp: () => {},
  });
  assert.equal(exitCode, 1);
  assert.match(stderrText, /usage/i);
});

test("real spawn: node --import tsx src/cli.tsx today --roots <tmp> prints the project row", () => {
  const root = makeProjectRoot(today());
  try {
    const output = execFileSync("node", ["--import", "tsx", "src/cli.tsx", "today", "--roots", root], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(output, /demo\s+tasks 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real spawn through a symlink (how npm's bin/kankaku runs it) still executes the CLI", () => {
  // npm installs the binary as `node_modules/.bin/kankaku -> ../kankaku-tui/dist/cli.js`,
  // so process.argv[1] is the symlink path while import.meta.url is the real
  // file; a main-module guard that compares them literally never runs.
  const root = makeProjectRoot(today());
  const linkDir = mkdtempSync(join(tmpdir(), "kankaku-bin-"));
  const link = join(linkDir, "kankaku");
  const repoRoot = new URL("..", import.meta.url).pathname;
  symlinkSync(join(repoRoot, "src", "cli.tsx"), link);
  try {
    const output = execFileSync("node", ["--import", "tsx", link, "today", "--roots", root], { cwd: repoRoot, encoding: "utf8" });
    assert.match(output, /demo\s+tasks 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(linkDir, { recursive: true, force: true });
  }
});
