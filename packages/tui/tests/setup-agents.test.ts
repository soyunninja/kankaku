import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentFacts } from "../src/adapters/setup/agents.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-setup-home-"));
}

test("readAgentFacts: every field is undefined on an empty home", () => {
  const home = makeHome();
  try {
    const facts = readAgentFacts(home);
    assert.deepEqual(facts, { pi: undefined, gentleShell: undefined, claudeCode: undefined, codex: undefined, opencode: undefined });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readAgentFacts: reads pi and gentle-shell packages from their own settings.json", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:kankaku"], theme: "x" }, null, 2));
    mkdirSync(join(home, ".gentle-shell", "agent"), { recursive: true });
    writeFileSync(join(home, ".gentle-shell", "agent", "settings.json"), JSON.stringify({ packages: ["../a/kankaku"] }, null, 2));

    const facts = readAgentFacts(home);
    assert.deepEqual(facts.pi, { settingsPath: join(home, ".pi", "agent", "settings.json"), packages: ["npm:kankaku"] });
    assert.deepEqual(facts.gentleShell, { settingsPath: join(home, ".gentle-shell", "agent", "settings.json"), packages: ["../a/kankaku"] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readAgentFacts: pi settings.json with no packages array reads as an empty list, never throws", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ theme: "x" }));
    const facts = readAgentFacts(home);
    assert.deepEqual(facts.pi?.packages, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readAgentFacts: malformed pi settings.json is treated as absent, never throws", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), "not json");
    const facts = readAgentFacts(home);
    assert.equal(facts.pi, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readAgentFacts: reads Claude Code's statusLine.command", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: 'node "/x/kankaku-claude/src/statusline.ts"' } }, null, 2),
    );
    const facts = readAgentFacts(home);
    assert.deepEqual(facts.claudeCode, {
      settingsPath: join(home, ".claude", "settings.json"),
      statusLineCommand: 'node "/x/kankaku-claude/src/statusline.ts"',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readAgentFacts: Claude Code settings.json without a statusLine reads as present with an undefined command", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "x" }));
    const facts = readAgentFacts(home);
    assert.deepEqual(facts.claudeCode, { settingsPath: join(home, ".claude", "settings.json"), statusLineCommand: undefined });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readAgentFacts: detects Codex and OpenCode config files by existence only", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "not-parsed = true");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), "{}");

    const facts = readAgentFacts(home);
    assert.deepEqual(facts.codex, { configPath: join(home, ".codex", "config.toml") });
    assert.deepEqual(facts.opencode, { configPath: join(home, ".config", "opencode", "opencode.json") });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
