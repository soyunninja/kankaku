import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStatusLine, removeStatusLine } from "../src/adapters/setup/claude.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-setup-claude-"));
}

test("writeStatusLine: sets statusLine.command to run the given checkout's statusline.ts, preserving other keys", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ model: "claude-fable-5-1", permissions: { allow: [] } }, null, 2));

    const result = writeStatusLine(settingsPath, "/Users/dev/kankaku-claude");
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.model, "claude-fable-5-1");
    assert.deepEqual(written.permissions, { allow: [] });
    assert.deepEqual(written.statusLine, { type: "command", command: 'node "/Users/dev/kankaku-claude/src/statusline.ts"' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStatusLine: replaces an existing non-kankaku statusLine", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "node other.js" } }, null, 2));

    const result = writeStatusLine(settingsPath, "/Users/dev/kankaku-claude");
    assert.equal(result.changed, true);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.statusLine.command, 'node "/Users/dev/kankaku-claude/src/statusline.ts"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStatusLine: is a no-op when the statusLine already points at kankaku's statusline.ts for this checkout", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const original = { statusLine: { type: "command", command: 'node "/Users/dev/kankaku-claude/src/statusline.ts"' } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));
    const before = readFileSync(settingsPath, "utf8");

    const result = writeStatusLine(settingsPath, "/Users/dev/kankaku-claude");
    assert.equal(result.changed, false);
    assert.equal(readFileSync(settingsPath, "utf8"), before);
    assert.equal(existsSync(`${settingsPath}.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStatusLine: backs up the original file before the first modification, and never overwrites an existing .bak", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const originalText = JSON.stringify({ model: "x" }, null, 2);
    writeFileSync(settingsPath, originalText);

    writeStatusLine(settingsPath, "/Users/dev/kankaku-claude");
    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), originalText);

    writeFileSync(`${settingsPath}.bak`, "sentinel");
    writeStatusLine(settingsPath, "/Users/dev/other-checkout");
    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), "sentinel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeStatusLine: removes statusLine when its command contains 'kankaku', preserving other keys", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const original = { model: "claude-fable-5-1", statusLine: { type: "command", command: 'node "/Users/dev/kankaku-claude/src/statusline.ts"' }, permissions: { allow: [] } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const result = removeStatusLine(settingsPath);
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(Object.keys(written), ["model", "permissions"]);
    assert.equal(written.model, "claude-fable-5-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeStatusLine: is a no-op when the statusLine command does not contain 'kankaku'", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const original = { statusLine: { type: "command", command: "node other.js" } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));
    const before = readFileSync(settingsPath, "utf8");

    const result = removeStatusLine(settingsPath);
    assert.equal(result.changed, false);
    assert.equal(readFileSync(settingsPath, "utf8"), before);
    assert.equal(existsSync(`${settingsPath}.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeStatusLine: is a no-op when there is no statusLine at all", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ model: "x" }, null, 2));

    const result = removeStatusLine(settingsPath);
    assert.equal(result.changed, false);
    assert.equal(existsSync(`${settingsPath}.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeStatusLine: backs up the original file before removing, and never overwrites an existing .bak", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const originalText = JSON.stringify({ statusLine: { type: "command", command: 'node "/x/kankaku-claude/src/statusline.ts"' } }, null, 2);
    writeFileSync(settingsPath, originalText);

    removeStatusLine(settingsPath);
    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), originalText);

    writeFileSync(settingsPath, originalText);
    writeFileSync(`${settingsPath}.bak`, "sentinel");
    removeStatusLine(settingsPath);
    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), "sentinel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
