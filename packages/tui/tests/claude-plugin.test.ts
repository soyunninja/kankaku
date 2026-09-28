import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateClaudePlugin, readPluginHooks, buildSettingsHooks } from "../src/adapters/setup/claude-plugin.ts";

function makePluginDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-claude-plugin-"));
}

function writeHooksJson(dir: string, hooks: Record<string, unknown>): void {
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks }, null, 2));
}

function writeHookScript(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "hook.ts"), "// fake\n");
}

// ---- locateClaudePlugin ----

test("locateClaudePlugin: resolves the real bundled kankaku-claude package when no override is given", () => {
  const result = locateClaudePlugin();
  assert.equal(typeof result.root, "string");
  assert.ok(result.root.includes("kankaku-claude") || result.root.endsWith("packages/claude"));
});

test("locateClaudePlugin: uses the override dir when it looks like a plugin root", () => {
  const dir = makePluginDir();
  try {
    writeHooksJson(dir, {});
    writeHookScript(dir);
    const result = locateClaudePlugin(dir);
    assert.equal(result.root, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("locateClaudePlugin: throws when the override is missing hooks/hooks.json", () => {
  const dir = makePluginDir();
  try {
    writeHookScript(dir);
    assert.throws(() => locateClaudePlugin(dir), /hooks\/hooks\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("locateClaudePlugin: throws when the override is missing src/hook.ts", () => {
  const dir = makePluginDir();
  try {
    writeHooksJson(dir, {});
    assert.throws(() => locateClaudePlugin(dir), /src\/hook\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- readPluginHooks ----

test("readPluginHooks: parses hooks/hooks.json's own hooks object", () => {
  const dir = makePluginDir();
  try {
    writeHooksJson(dir, {
      SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/src/hook.ts"', timeout: 15 }] }],
    });
    const hooks = readPluginHooks(dir);
    assert.deepEqual(hooks, {
      SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/src/hook.ts"', timeout: 15 }] }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPluginHooks: reads the real bundled hooks.json (every event from the plugin)", () => {
  const { root } = locateClaudePlugin();
  const hooks = readPluginHooks(root);
  assert.ok(Object.keys(hooks).length > 0);
  assert.ok("SessionStart" in hooks);
});

// ---- buildSettingsHooks ----

test("buildSettingsHooks: replaces ${CLAUDE_PLUGIN_ROOT} with the resolved root in every command, keeping event order/matchers/timeouts", () => {
  const pluginHooks = {
    SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/src/hook.ts"', timeout: 15 }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/src/hook.ts"', timeout: 5 }] }],
  };
  const built = buildSettingsHooks("/root/kankaku-claude", pluginHooks);
  assert.deepEqual(built, {
    SessionStart: [{ hooks: [{ type: "command", command: 'node "/root/kankaku-claude/src/hook.ts"', timeout: 15 }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "/root/kankaku-claude/src/hook.ts"', timeout: 5 }] }],
  });
  assert.deepEqual(Object.keys(built), ["SessionStart", "PreToolUse"]);
});
