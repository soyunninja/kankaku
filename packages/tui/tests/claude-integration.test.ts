import { test } from "node:test";
import assert from "node:assert/strict";
import { ourHookCommandRoot, ourStatusLineCommandRoot } from "../src/domain/claude-integration.ts";

// ---- ourHookCommandRoot ----

test("ourHookCommandRoot: extracts the root from a kankaku-claude checkout-style command", () => {
  assert.equal(ourHookCommandRoot('node "/Users/dev/kankaku-claude/src/hook.ts"'), "/Users/dev/kankaku-claude");
});

test("ourHookCommandRoot: extracts the root from a bundled packages/claude-style command", () => {
  assert.equal(ourHookCommandRoot('node "/x/node_modules/kankaku-tui/node_modules/kankaku-claude/src/hook.ts"'), "/x/node_modules/kankaku-tui/node_modules/kankaku-claude/src/hook.ts".replace(/\/src\/hook\.ts$/, ""));
});

test("ourHookCommandRoot: returns undefined for a command that doesn't end in /src/hook.ts", () => {
  assert.equal(ourHookCommandRoot('node "/x/kankaku-claude/src/other.ts"'), undefined);
});

test("ourHookCommandRoot: returns undefined when the root doesn't look like ours", () => {
  assert.equal(ourHookCommandRoot('node "/x/some-other-plugin/src/hook.ts"'), undefined);
});

test("ourHookCommandRoot: returns undefined for a completely unrelated command", () => {
  assert.equal(ourHookCommandRoot("node other.js"), undefined);
});

// ---- ourStatusLineCommandRoot ----

test("ourStatusLineCommandRoot: extracts the root from a kankaku-claude statusline command", () => {
  assert.equal(ourStatusLineCommandRoot('node "/Users/dev/kankaku-claude/src/statusline.ts"'), "/Users/dev/kankaku-claude");
});

test("ourStatusLineCommandRoot: recognizes a packages/claude checkout root", () => {
  assert.equal(ourStatusLineCommandRoot('node "/checkout/packages/claude/src/statusline.ts"'), "/checkout/packages/claude");
});

test("ourStatusLineCommandRoot: returns undefined for an unrelated command", () => {
  assert.equal(ourStatusLineCommandRoot("node other.js"), undefined);
});

test("ourStatusLineCommandRoot: returns undefined when the root doesn't look like ours", () => {
  assert.equal(ourStatusLineCommandRoot('node "/x/some-other-tool/src/statusline.ts"'), undefined);
});
