import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli.tsx";
import { DEFAULT_THEME, GENTLE_THEME } from "../src/ui/theme.ts";
import type { Theme } from "../src/ui/theme.ts";

function baseDeps(overrides: Partial<Parameters<typeof runCli>[1]> = {}) {
  return {
    homeDir: "/tmp",
    cwd: "/tmp",
    stdout: () => {},
    stderr: () => {},
    exit: () => {},
    renderApp: () => {},
    env: {},
    ...overrides,
  };
}

test("runCli with no --theme/env renders with the default (gentleman-sexy) theme", async () => {
  let rendered: Theme | undefined;
  await runCli([], baseDeps({ renderApp: (_roots, theme) => { rendered = theme; } }));
  assert.deepEqual(rendered, DEFAULT_THEME);
});

test("--theme selects a named preset and wins over the env", async () => {
  let rendered: Theme | undefined;
  await runCli(
    ["--theme", "gentle"],
    baseDeps({ env: { KANKAKU_TUI_THEME: "gentleman-cute" }, renderApp: (_roots, theme) => { rendered = theme; } }),
  );
  assert.deepEqual(rendered, GENTLE_THEME);
});

test("KANKAKU_TUI_THEME selects a named preset when no --theme flag is given", async () => {
  let rendered: Theme | undefined;
  await runCli([], baseDeps({ env: { KANKAKU_TUI_THEME: "gentle" }, renderApp: (_roots, theme) => { rendered = theme; } }));
  assert.deepEqual(rendered, GENTLE_THEME);
});

test("an unknown --theme name fails with a usage error listing the valid names, without rendering", async () => {
  let stderrText = "";
  let exitCode: number | undefined;
  let renderCalled = false;
  await runCli(
    ["--theme", "bogus"],
    baseDeps({
      stderr: (text) => (stderrText += text),
      exit: (code) => { exitCode = code; },
      renderApp: () => { renderCalled = true; },
    }),
  );
  assert.equal(exitCode, 1);
  assert.equal(renderCalled, false);
  assert.match(stderrText, /bogus/);
  assert.match(stderrText, /gentleman-sexy/);
  assert.match(stderrText, /gentleman-cute/);
  assert.match(stderrText, /gentle/);
});

test("an unknown KANKAKU_TUI_THEME env value fails the same way", async () => {
  let stderrText = "";
  let exitCode: number | undefined;
  await runCli(
    [],
    baseDeps({
      env: { KANKAKU_TUI_THEME: "bogus" },
      stderr: (text) => (stderrText += text),
      exit: (code) => { exitCode = code; },
    }),
  );
  assert.equal(exitCode, 1);
  assert.match(stderrText, /bogus/);
});

test("--theme is stripped from argv before the roots/subcommand parsing sees it", async () => {
  let stderrText = "";
  let exitCode: number | undefined;
  await runCli(
    ["--theme", "gentle", "bogus-command"],
    baseDeps({
      stderr: (text) => (stderrText += text),
      exit: (code) => { exitCode = code; },
    }),
  );
  // Reaches the ordinary "unknown subcommand" usage path, proving `--theme gentle` was consumed cleanly rather than being mistaken for a subcommand.
  assert.equal(exitCode, 1);
  assert.match(stderrText, /usage/i);
});
