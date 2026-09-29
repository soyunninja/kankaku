import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandsDirectory, readPluginCommands, removeClaudeCommands, writeClaudeCommands } from "../src/adapters/setup/claude-commands.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-claude-commands-"));
}

const ROOT = "/Users/dev/kankaku-claude";
const REPORT = { name: "report", source: 'run\n!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" report\n' };
const STATUS = { name: "status", source: 'run\n!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" status\n' };

test("commandsDirectory: lives under ~/.claude/commands/kankaku", () => {
  assert.equal(commandsDirectory("/h"), join("/h", ".claude", "commands", "kankaku"));
});

test("readPluginCommands: reads commands/*.md sorted by name, ignoring other files; missing directory reads as none", () => {
  const dir = makeDir();
  try {
    assert.deepEqual(readPluginCommands(dir), []);
    mkdirSync(join(dir, "commands"));
    writeFileSync(join(dir, "commands", "status.md"), "s");
    writeFileSync(join(dir, "commands", "report.md"), "r");
    writeFileSync(join(dir, "commands", "notes.txt"), "x");
    assert.deepEqual(readPluginCommands(dir), [
      { name: "report", source: "r" },
      { name: "status", source: "s" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudeCommands: creates the directory and writes each command with the plugin root substituted", () => {
  const home = makeDir();
  try {
    const result = writeClaudeCommands(home, ROOT, [REPORT, STATUS]);
    const dir = commandsDirectory(home);
    assert.deepEqual(result.wrote, [join(dir, "report.md"), join(dir, "status.md")]);
    assert.deepEqual([result.unchanged, result.removed, result.foreign], [[], [], []]);
    assert.equal(readFileSync(join(dir, "report.md"), "utf8"), `run\n!node "${ROOT}/dist/cli.js" report\n`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeClaudeCommands: byte-identical files are unchanged and not rewritten", () => {
  const home = makeDir();
  try {
    writeClaudeCommands(home, ROOT, [REPORT]);
    const result = writeClaudeCommands(home, ROOT, [REPORT]);
    assert.deepEqual(result.wrote, []);
    assert.deepEqual(result.unchanged, [join(commandsDirectory(home), "report.md")]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeClaudeCommands: a file pointing at another root is rewritten", () => {
  const home = makeDir();
  try {
    writeClaudeCommands(home, "/old/kankaku-claude", [REPORT]);
    const result = writeClaudeCommands(home, ROOT, [REPORT]);
    assert.equal(result.wrote.length, 1);
    assert.match(readFileSync(join(commandsDirectory(home), "report.md"), "utf8"), /\/Users\/dev\/kankaku-claude\/dist\/cli\.js/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeClaudeCommands: removes generated files the plugin no longer ships", () => {
  const home = makeDir();
  try {
    writeClaudeCommands(home, ROOT, [REPORT, STATUS]);
    const result = writeClaudeCommands(home, ROOT, [REPORT]);
    const dir = commandsDirectory(home);
    assert.deepEqual(result.removed, [join(dir, "status.md")]);
    assert.equal(existsSync(join(dir, "status.md")), false);
    assert.equal(existsSync(join(dir, "report.md")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeClaudeCommands: never overwrites or removes a foreign file, and reports it", () => {
  const home = makeDir();
  try {
    const dir = commandsDirectory(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), "my own report command\n");
    writeFileSync(join(dir, "mine.md"), "something else\n");
    writeFileSync(join(dir, "README.txt"), "notes\n");

    const result = writeClaudeCommands(home, ROOT, [REPORT, STATUS]);

    assert.deepEqual(result.wrote, [join(dir, "status.md")]);
    assert.deepEqual(result.foreign, [join(dir, "README.txt"), join(dir, "mine.md"), join(dir, "report.md")]);
    assert.equal(readFileSync(join(dir, "report.md"), "utf8"), "my own report command\n");
    assert.equal(existsSync(join(dir, "mine.md")), true);
    assert.equal(existsSync(join(dir, "README.txt")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("removeClaudeCommands: removes ours and the directory when empty, without touching siblings under ~/.claude/commands", () => {
  const home = makeDir();
  try {
    writeClaudeCommands(home, ROOT, [REPORT, STATUS]);
    const sibling = join(home, ".claude", "commands", "mine.md");
    writeFileSync(sibling, "mine\n");

    const result = removeClaudeCommands(home);

    const dir = commandsDirectory(home);
    assert.deepEqual(result.removed, [join(dir, "report.md"), join(dir, "status.md")]);
    assert.equal(existsSync(dir), false);
    assert.equal(readFileSync(sibling, "utf8"), "mine\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("removeClaudeCommands: keeps the directory and reports foreign files when any remain", () => {
  const home = makeDir();
  try {
    writeClaudeCommands(home, ROOT, [REPORT]);
    const dir = commandsDirectory(home);
    writeFileSync(join(dir, "mine.md"), "mine\n");

    const result = removeClaudeCommands(home);

    assert.deepEqual(result.removed, [join(dir, "report.md")]);
    assert.deepEqual(result.foreign, [join(dir, "mine.md")]);
    assert.deepEqual(readdirSync(dir), ["mine.md"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("removeClaudeCommands: a missing directory is a no-op", () => {
  const home = makeDir();
  try {
    const result = removeClaudeCommands(home);
    assert.deepEqual([result.wrote, result.unchanged, result.removed, result.foreign], [[], [], [], []]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeClaudeCommands: a failed rename leaves no .tmp file behind", () => {
  const home = makeDir();
  try {
    const dir = commandsDirectory(home);
    mkdirSync(join(dir, "report.md"), { recursive: true }); // a directory at the target: rename onto it fails
    assert.throws(() => writeClaudeCommands(home, ROOT, [REPORT]));
    assert.deepEqual(readdirSync(dir), ["report.md"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
