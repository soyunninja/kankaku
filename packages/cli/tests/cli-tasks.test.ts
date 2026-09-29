import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.tsx";

function fixtureLine(id: string, day: string, prompt = "hello"): string {
  return JSON.stringify({
    schema: 1,
    id,
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "demo",
    prompt,
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

function makeProjectRoot(lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "kankaku-cli-cli-tasks-"));
  const project = join(root, "demo");
  mkdirSync(join(project, ".kankaku"), { recursive: true });
  writeFileSync(join(project, ".kankaku", "worklog.jsonl"), `${lines.join("\n")}\n`);
  return root;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function baseDeps(root: string, extra: Partial<Parameters<typeof runCli>[1]> = {}) {
  return {
    homeDir: root,
    cwd: root,
    stdout: () => {},
    stderr: () => {},
    exit: () => {},
    renderApp: () => {
      throw new Error("should not render the TUI for 'tasks'");
    },
    ...extra,
  };
}

test("runCli 'tasks' prints today's tasks per project with a header", async () => {
  const root = makeProjectRoot([fixtureLine("r1", today(), "today's prompt")]);
  try {
    const lines: string[] = [];
    await runCli(["tasks", "--roots", root], baseDeps(root, { stdout: (text) => lines.push(text) }));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /== demo ==/);
    assert.match(lines[0]!, /today's prompt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCli 'tasks' excludes tasks from other days unless --all is given", async () => {
  const root = makeProjectRoot([fixtureLine("old", "2020-01-01", "an old prompt")]);
  try {
    const lines: string[] = [];
    await runCli(["tasks", "--roots", root], baseDeps(root, { stdout: (text) => lines.push(text) }));
    assert.equal(lines[0], "no tasks");

    const allLines: string[] = [];
    await runCli(["tasks", "--all", "--roots", root], baseDeps(root, { stdout: (text) => allLines.push(text) }));
    assert.match(allLines[0]!, /an old prompt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real spawn: node --import tsx src/cli.tsx tasks --all --roots <tmp> prints the project row", () => {
  const root = makeProjectRoot([fixtureLine("r1", "2020-01-01", "spawned prompt")]);
  try {
    const output = execFileSync("node", ["--import", "tsx", "src/cli.tsx", "tasks", "--all", "--roots", root], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
    });
    assert.match(output, /== demo ==/);
    assert.match(output, /spawned prompt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
