import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeClaudeIntegration, removeClaudeIntegration } from "../src/adapters/setup/claude.ts";
import type { PluginHooks } from "../src/adapters/setup/claude-plugin.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-setup-claude-"));
}

const ROOT = "/Users/dev/kankaku-claude";

function pluginHooks(): PluginHooks {
  return {
    SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"', timeout: 15 }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"', timeout: 5 }] }],
  };
}

function ourHooksFor(root: string): Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]> {
  return {
    SessionStart: [{ hooks: [{ type: "command", command: `node "${root}/dist/hook.js"`, timeout: 15 }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `node "${root}/dist/hook.js"`, timeout: 5 }] }],
  };
}

// ---- writeClaudeIntegration ----

test("writeClaudeIntegration: sets statusLine and hooks for every plugin event, preserving other keys", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ model: "claude-fable-5-1", permissions: { allow: [] } }, null, 2));

    const result = writeClaudeIntegration(settingsPath, ROOT, pluginHooks());
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.model, "claude-fable-5-1");
    assert.deepEqual(written.permissions, { allow: [] });
    assert.deepEqual(written.statusLine, { type: "command", command: `node "${ROOT}/dist/statusline.js"` });
    assert.deepEqual(written.hooks, ourHooksFor(ROOT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudeIntegration: is a no-op when statusLine and every event's hooks already match this root", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const original = { statusLine: { type: "command", command: `node "${ROOT}/dist/statusline.js"` }, hooks: ourHooksFor(ROOT) };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));
    const before = readFileSync(settingsPath, "utf8");

    const result = writeClaudeIntegration(settingsPath, ROOT, pluginHooks());
    assert.equal(result.changed, false);
    assert.equal(readFileSync(settingsPath, "utf8"), before);
    assert.equal(existsSync(`${settingsPath}.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudeIntegration: preserves a foreign hook entry in the same event, merging ours alongside it", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const foreignEntry = { hooks: [{ type: "command", command: "node other-tool.js" }] };
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [foreignEntry] } }, null, 2));

    writeClaudeIntegration(settingsPath, ROOT, pluginHooks());

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.hooks.SessionStart, [foreignEntry, ...ourHooksFor(ROOT).SessionStart]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudeIntegration: preserves an unrelated event entirely untouched", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const notificationEntry = { hooks: [{ type: "command", command: "node notify.js" }] };
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Notification: [notificationEntry] } }, null, 2));

    writeClaudeIntegration(settingsPath, ROOT, pluginHooks());

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.hooks.Notification, [notificationEntry]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudeIntegration: replaces stale entries pointing at another root", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const staleRoot = "/old/kankaku-claude";
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: `node "${staleRoot}/dist/statusline.js"` }, hooks: ourHooksFor(staleRoot) }, null, 2),
    );

    const result = writeClaudeIntegration(settingsPath, ROOT, pluginHooks());
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.statusLine, { type: "command", command: `node "${ROOT}/dist/statusline.js"` });
    assert.deepEqual(written.hooks, ourHooksFor(ROOT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudeIntegration: replaces a legacy src-form statusLine and hooks at the same root with the dist form", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const legacyHooks = {
      SessionStart: [{ hooks: [{ type: "command", command: `node "${ROOT}/src/hook.ts"`, timeout: 15 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `node "${ROOT}/src/hook.ts"`, timeout: 5 }] }],
    };
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: `node "${ROOT}/src/statusline.ts"` }, hooks: legacyHooks }, null, 2),
    );

    const result = writeClaudeIntegration(settingsPath, ROOT, pluginHooks());
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.statusLine, { type: "command", command: `node "${ROOT}/dist/statusline.js"` });
    assert.deepEqual(written.hooks, ourHooksFor(ROOT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudeIntegration: replaces a non-kankaku statusLine", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "node other.js" } }, null, 2));

    const result = writeClaudeIntegration(settingsPath, ROOT, pluginHooks());
    assert.equal(result.changed, true);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.statusLine.command, `node "${ROOT}/dist/statusline.js"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudeIntegration: backs up the original file before the first modification, and never overwrites an existing .bak", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const originalText = JSON.stringify({ model: "x" }, null, 2);
    writeFileSync(settingsPath, originalText);

    writeClaudeIntegration(settingsPath, ROOT, pluginHooks());
    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), originalText);

    writeFileSync(`${settingsPath}.bak`, "sentinel");
    writeClaudeIntegration(settingsPath, "/other/kankaku-claude", pluginHooks());
    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), "sentinel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- removeClaudeIntegration ----

test("removeClaudeIntegration: removes exactly our statusLine and hooks, preserving other keys", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const original = {
      model: "claude-fable-5-1",
      statusLine: { type: "command", command: `node "${ROOT}/dist/statusline.js"` },
      hooks: ourHooksFor(ROOT),
      permissions: { allow: [] },
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const result = removeClaudeIntegration(settingsPath);
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(Object.keys(written), ["model", "permissions"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeClaudeIntegration: keeps a foreign hook entry in a shared event, dropping only ours", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const foreignEntry = { hooks: [{ type: "command", command: "node other-tool.js" }] };
    const original = { hooks: { SessionStart: [foreignEntry, ...ourHooksFor(ROOT).SessionStart!] } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const result = removeClaudeIntegration(settingsPath);
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.hooks.SessionStart, [foreignEntry]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeClaudeIntegration: drops an event array once it is empty, and the hooks key once every event is empty", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: ourHooksFor(ROOT) }, null, 2));

    const result = removeClaudeIntegration(settingsPath);
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal("hooks" in written, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeClaudeIntegration: removes a legacy src-form statusLine and hooks", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const legacyHooks = {
      SessionStart: [{ hooks: [{ type: "command", command: `node "${ROOT}/src/hook.ts"`, timeout: 15 }] }],
    };
    const original = { model: "x", statusLine: { type: "command", command: `node "${ROOT}/src/statusline.ts"` }, hooks: legacyHooks };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const result = removeClaudeIntegration(settingsPath);
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(Object.keys(written), ["model"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeClaudeIntegration: preserves a foreign statusLine untouched", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const original = { statusLine: { type: "command", command: "node other.js" }, hooks: ourHooksFor(ROOT) };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    removeClaudeIntegration(settingsPath);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.statusLine, { type: "command", command: "node other.js" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeClaudeIntegration: is a no-op when neither statusLine nor hooks are ours", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const original = { statusLine: { type: "command", command: "node other.js" }, hooks: { Notification: [{ hooks: [{ type: "command", command: "node notify.js" }] }] } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));
    const before = readFileSync(settingsPath, "utf8");

    const result = removeClaudeIntegration(settingsPath);
    assert.equal(result.changed, false);
    assert.equal(readFileSync(settingsPath, "utf8"), before);
    assert.equal(existsSync(`${settingsPath}.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeClaudeIntegration: is a no-op when there is nothing at all", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ model: "x" }, null, 2));

    const result = removeClaudeIntegration(settingsPath);
    assert.equal(result.changed, false);
    assert.equal(existsSync(`${settingsPath}.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeClaudeIntegration: backs up the original file before removing, and never overwrites an existing .bak", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const originalText = JSON.stringify({ statusLine: { type: "command", command: `node "${ROOT}/dist/statusline.js"` }, hooks: ourHooksFor(ROOT) }, null, 2);
    writeFileSync(settingsPath, originalText);

    removeClaudeIntegration(settingsPath);
    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), originalText);

    writeFileSync(settingsPath, originalText);
    writeFileSync(`${settingsPath}.bak`, "sentinel");
    removeClaudeIntegration(settingsPath);
    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), "sentinel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudeIntegration: tolerates a malformed existing hook entry instead of throwing", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [null, { notHooks: true }, { hooks: "not-an-array" }] } }, null, 2));

    assert.doesNotThrow(() => writeClaudeIntegration(settingsPath, ROOT, pluginHooks()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeClaudeIntegration: tolerates a malformed existing hook entry instead of throwing", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [null, { notHooks: true }, ...ourHooksFor(ROOT).SessionStart] } }, null, 2));

    assert.doesNotThrow(() => removeClaudeIntegration(settingsPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
