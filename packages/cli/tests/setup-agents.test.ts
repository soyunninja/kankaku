import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentFacts } from "../src/adapters/setup/agents.ts";
import { writeClaudeIntegration } from "../src/adapters/setup/claude.ts";
import { commandsDirectory, readPluginCommands, writeClaudeCommands } from "../src/adapters/setup/claude-commands.ts";
import { readPluginHooks } from "../src/adapters/setup/claude-plugin.ts";
import { readFileSync } from "node:fs";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-setup-home-"));
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

test("readAgentFacts: reads Claude Code's hooksRoot from a matching kankaku hook entry", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: 'node "/x/kankaku-claude/dist/hook.js"', timeout: 15 }] }],
            Notification: [{ hooks: [{ type: "command", command: "node notify.js" }] }],
          },
        },
        null,
        2,
      ),
    );
    const facts = readAgentFacts(home);
    assert.equal(facts.claudeCode?.hooksRoot, "/x/kankaku-claude");
    assert.equal(facts.claudeCode?.hooksLegacy, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readAgentFacts: reads Claude Code's hooksLegacy=true from a legacy src-form kankaku hook entry", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify(
        { hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'node "/x/kankaku-claude/src/hook.ts"', timeout: 15 }] }] } },
        null,
        2,
      ),
    );
    const facts = readAgentFacts(home);
    assert.equal(facts.claudeCode?.hooksRoot, "/x/kankaku-claude");
    assert.equal(facts.claudeCode?.hooksLegacy, true);
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
      JSON.stringify({ statusLine: { type: "command", command: 'node "/x/kankaku-claude/dist/statusline.js"' } }, null, 2),
    );
    const facts = readAgentFacts(home);
    assert.equal(facts.claudeCode?.settingsPath, join(home, ".claude", "settings.json"));
    assert.equal(facts.claudeCode?.statusLineCommand, 'node "/x/kankaku-claude/dist/statusline.js"');
    assert.equal(facts.claudeCode?.hooksRoot, undefined);
    assert.equal(facts.claudeCode?.hooksLegacy, false);
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
    assert.equal(facts.claudeCode?.settingsPath, join(home, ".claude", "settings.json"));
    assert.equal(facts.claudeCode?.statusLineCommand, undefined);
    assert.equal(facts.claudeCode?.hooksRoot, undefined);
    assert.equal(facts.claudeCode?.hooksLegacy, false);
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


/** A fake plugin root with two events and two commands, fully installed into `home`. */
function installedFixture(): { home: string; plugin: string; settingsPath: string } {
  const home = makeHome();
  const plugin = mkdtempSync(join(tmpdir(), "kankaku-claude-fake-plugin-"));
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  mkdirSync(join(plugin, "dist"), { recursive: true });
  mkdirSync(join(plugin, "commands"), { recursive: true });
  writeFileSync(join(plugin, "dist", "hook.js"), "// fake\n");
  writeFileSync(
    join(plugin, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"', timeout: 15 }] }],
        Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"', timeout: 30 }] }],
      },
    }),
  );
  writeFileSync(join(plugin, "commands", "report.md"), 'r\n!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" report\n');
  writeFileSync(join(plugin, "commands", "sync.md"), 'r\n!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" sync\n');
  mkdirSync(join(home, ".claude"), { recursive: true });
  const settingsPath = join(home, ".claude", "settings.json");
  writeClaudeIntegration(settingsPath, plugin, readPluginHooks(plugin));
  writeClaudeCommands(home, plugin, readPluginCommands(plugin));
  return { home, plugin, settingsPath };
}

function cleanup(f: { home: string; plugin: string }): void {
  rmSync(f.home, { recursive: true, force: true });
  rmSync(f.plugin, { recursive: true, force: true });
}

const NO_DRIFT = {
  hooksMissingEvents: [],
  hooksOutdatedEvents: [],
  commandsMissing: [],
  commandsOutdated: [],
  commandsStale: [],
  statusLineOutdated: false,
};

test("readAgentFacts: a fully installed Claude Code reports no drift against the plugin", () => {
  const f = installedFixture();
  try {
    const facts = readAgentFacts(f.home, f.plugin).claudeCode!;
    for (const [key, value] of Object.entries(NO_DRIFT)) assert.deepEqual(facts[key as keyof typeof facts], value, key);
    assert.equal(facts.pluginError, undefined);
  } finally {
    cleanup(f);
  }
});

test("readAgentFacts: hook events removed from settings.json are missing", () => {
  const f = installedFixture();
  try {
    const settings = JSON.parse(readFileSync(f.settingsPath, "utf8"));
    delete settings.hooks.Stop;
    writeFileSync(f.settingsPath, JSON.stringify(settings));
    assert.deepEqual(readAgentFacts(f.home, f.plugin).claudeCode?.hooksMissingEvents, ["Stop"]);
  } finally {
    cleanup(f);
  }
});

test("readAgentFacts: a hook whose timeout differs from the plugin's is outdated; foreign entries are ignored", () => {
  const f = installedFixture();
  try {
    const settings = JSON.parse(readFileSync(f.settingsPath, "utf8"));
    settings.hooks.Stop[0].hooks[0].timeout = 5;
    settings.hooks.SessionStart.push({ hooks: [{ type: "command", command: "node foreign.js" }] });
    writeFileSync(f.settingsPath, JSON.stringify(settings));
    const facts = readAgentFacts(f.home, f.plugin).claudeCode!;
    assert.deepEqual(facts.hooksOutdatedEvents, ["Stop"]);
    assert.deepEqual(facts.hooksMissingEvents, []);
  } finally {
    cleanup(f);
  }
});

test("readAgentFacts: a deleted command is missing, an edited one outdated, an extra generated one stale; a foreign file is ignored", () => {
  const f = installedFixture();
  try {
    const dir = commandsDirectory(f.home);
    rmSync(join(dir, "sync.md"));
    writeFileSync(join(dir, "report.md"), readFileSync(join(dir, "report.md"), "utf8") + "extra\n");
    writeFileSync(join(dir, "old.md"), `!node "${f.plugin}/dist/cli.js" old\n`);
    writeFileSync(join(dir, "custom.md"), "mine\n");
    const facts = readAgentFacts(f.home, f.plugin).claudeCode!;
    assert.deepEqual(facts.commandsMissing, ["sync"]);
    assert.deepEqual(facts.commandsOutdated, ["report"]);
    assert.deepEqual(facts.commandsStale, ["old"]);
  } finally {
    cleanup(f);
  }
});

test("readAgentFacts: a statusLine pointing at another root is outdated", () => {
  const f = installedFixture();
  try {
    const settings = JSON.parse(readFileSync(f.settingsPath, "utf8"));
    settings.statusLine.command = 'node "/old/kankaku-claude/dist/statusline.js"';
    writeFileSync(f.settingsPath, JSON.stringify(settings));
    assert.equal(readAgentFacts(f.home, f.plugin).claudeCode?.statusLineOutdated, true);
  } finally {
    cleanup(f);
  }
});

test("readAgentFacts: an unresolvable plugin root is reported as pluginError", () => {
  const f = installedFixture();
  try {
    const facts = readAgentFacts(f.home, join(f.home, "nowhere")).claudeCode!;
    assert.match(facts.pluginError ?? "", /nowhere/);
  } finally {
    cleanup(f);
  }
});

test("readAgentFacts: an object-form pi package contributes its source; entries without one are ignored", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ packages: ["npm:pi-lens", { source: "npm:kankaku-pi", extensions: ["!x"] }, { extensions: [] }, 7] }, null, 2),
    );
    assert.deepEqual(readAgentFacts(home).pi?.packages, ["npm:pi-lens", "npm:kankaku-pi"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
