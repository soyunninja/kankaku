import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommandFileContent, ourCommandFileRoot, ourHookCommandRoot, ourStatusLineCommandRoot, ourHookCommandMatch, ourStatusLineCommandMatch } from "../src/domain/claude-integration.ts";

// ---- ourHookCommandRoot (current dist/hook.js form) ----

test("ourHookCommandRoot: extracts the root from a kankaku-claude checkout-style command", () => {
  assert.equal(ourHookCommandRoot('node "/Users/dev/kankaku-claude/dist/hook.js"'), "/Users/dev/kankaku-claude");
});

test("ourHookCommandRoot: extracts the root from a bundled packages/claude-style command", () => {
  assert.equal(
    ourHookCommandRoot('node "/x/node_modules/kankaku-tui/node_modules/kankaku-claude/dist/hook.js"'),
    "/x/node_modules/kankaku-tui/node_modules/kankaku-claude/dist/hook.js".replace(/\/dist\/hook\.js$/, ""),
  );
});

test("ourHookCommandRoot: returns undefined for a command that doesn't end in /dist/hook.js or /src/hook.ts", () => {
  assert.equal(ourHookCommandRoot('node "/x/kankaku-claude/dist/other.js"'), undefined);
});

test("ourHookCommandRoot: returns undefined when the root doesn't look like ours", () => {
  assert.equal(ourHookCommandRoot('node "/x/some-other-plugin/dist/hook.js"'), undefined);
});

test("ourHookCommandRoot: returns undefined for a completely unrelated command", () => {
  assert.equal(ourHookCommandRoot("node other.js"), undefined);
});

// ---- ourHookCommandRoot (legacy /src/hook.ts form, still recognized so setup replaces/removes it) ----

test("ourHookCommandRoot: still recognizes the legacy /src/hook.ts checkout form", () => {
  assert.equal(ourHookCommandRoot('node "/Users/dev/kankaku-claude/src/hook.ts"'), "/Users/dev/kankaku-claude");
});

test("ourHookCommandRoot: still recognizes a legacy bundled packages/claude /src/hook.ts form", () => {
  assert.equal(ourHookCommandRoot('node "/x/node_modules/kankaku-claude/src/hook.ts"'), "/x/node_modules/kankaku-claude");
});

// ---- ourStatusLineCommandRoot (current dist/statusline.js form) ----

test("ourStatusLineCommandRoot: extracts the root from a kankaku-claude statusline command", () => {
  assert.equal(ourStatusLineCommandRoot('node "/Users/dev/kankaku-claude/dist/statusline.js"'), "/Users/dev/kankaku-claude");
});

test("ourStatusLineCommandRoot: recognizes a packages/claude checkout root", () => {
  assert.equal(ourStatusLineCommandRoot('node "/checkout/packages/claude/dist/statusline.js"'), "/checkout/packages/claude");
});

test("ourStatusLineCommandRoot: returns undefined for an unrelated command", () => {
  assert.equal(ourStatusLineCommandRoot("node other.js"), undefined);
});

test("ourStatusLineCommandRoot: returns undefined when the root doesn't look like ours", () => {
  assert.equal(ourStatusLineCommandRoot('node "/x/some-other-tool/dist/statusline.js"'), undefined);
});

// ---- ourStatusLineCommandRoot (legacy /src/statusline.ts form) ----

test("ourStatusLineCommandRoot: still recognizes the legacy /src/statusline.ts checkout form", () => {
  assert.equal(ourStatusLineCommandRoot('node "/checkout/packages/claude/src/statusline.ts"'), "/checkout/packages/claude");
});

// ---- ourHookCommandMatch / ourStatusLineCommandMatch (root + whether it's the outdated legacy form) ----

test("ourHookCommandMatch: current dist form is not legacy", () => {
  assert.deepEqual(ourHookCommandMatch('node "/x/kankaku-claude/dist/hook.js"'), { root: "/x/kankaku-claude", legacy: false });
});

test("ourHookCommandMatch: legacy src form is reported as legacy", () => {
  assert.deepEqual(ourHookCommandMatch('node "/x/kankaku-claude/src/hook.ts"'), { root: "/x/kankaku-claude", legacy: true });
});

test("ourHookCommandMatch: undefined for an unrelated command", () => {
  assert.equal(ourHookCommandMatch("node other.js"), undefined);
});

test("ourStatusLineCommandMatch: current dist form is not legacy", () => {
  assert.deepEqual(ourStatusLineCommandMatch('node "/x/kankaku-claude/dist/statusline.js"'), { root: "/x/kankaku-claude", legacy: false });
});

test("ourStatusLineCommandMatch: legacy src form is reported as legacy", () => {
  assert.deepEqual(ourStatusLineCommandMatch('node "/x/kankaku-claude/src/statusline.ts"'), { root: "/x/kankaku-claude", legacy: true });
});

test("ourStatusLineCommandMatch: undefined for an unrelated command", () => {
  assert.equal(ourStatusLineCommandMatch("node other.js"), undefined);
});

// ---- generated slash commands ----

test("buildCommandFileContent: replaces every ${CLAUDE_PLUGIN_ROOT} with the absolute root and touches nothing else", () => {
  const source = 'a ${CLAUDE_PLUGIN_ROOT}/x\n!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" sync $ARGUMENTS\n${OTHER}\n';
  assert.equal(
    buildCommandFileContent("/r/kankaku-claude", source),
    'a /r/kankaku-claude/x\n!node "/r/kankaku-claude/dist/cli.js" sync $ARGUMENTS\n${OTHER}\n',
  );
});

test("ourCommandFileRoot: extracts the plugin root from a generated command file", () => {
  assert.equal(ourCommandFileRoot('x\n!node "/a/node_modules/kankaku-claude/dist/cli.js" report\n'), "/a/node_modules/kankaku-claude");
  assert.equal(ourCommandFileRoot('!node "/dev/kankaku/packages/claude/dist/cli.js" status'), "/dev/kankaku/packages/claude");
});

test("ourCommandFileRoot: a file is ours when any invocation matches, even if others do not", () => {
  assert.equal(ourCommandFileRoot('!node "/x/other/dist/cli.js" a\n!node "/y/kankaku-claude/dist/cli.js" b'), "/y/kankaku-claude");
});

test("ourCommandFileRoot: undefined for foreign content, other cli paths and other entry points", () => {
  assert.equal(ourCommandFileRoot("just notes"), undefined);
  assert.equal(ourCommandFileRoot('!node "/x/other-tool/dist/cli.js" report'), undefined);
  assert.equal(ourCommandFileRoot('!node "/x/kankaku-claude/dist/hook.js"'), undefined);
});
