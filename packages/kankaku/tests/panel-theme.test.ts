import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildSelectListTheme, buildSettingsListTheme } from "../src/adapters/panel/panel-theme.ts";

/** Records every `fg(role, text)` call and returns `<role>:<text>` so assertions can check role mapping without a real terminal theme. */
function fakeTheme(): Theme {
  return {
    fg: (role: string, text: string) => `${role}:${text}`,
    bold: (text: string) => `bold:${text}`,
  } as unknown as Theme;
}

test("buildSelectListTheme mirrors pi's own select-list role mapping (accent/muted)", () => {
  const theme = buildSelectListTheme(fakeTheme());
  assert.equal(theme.selectedPrefix("x"), "accent:x");
  assert.equal(theme.selectedText("x"), "accent:x");
  assert.equal(theme.description("x"), "muted:x");
  assert.equal(theme.scrollInfo("x"), "muted:x");
  assert.equal(theme.noMatch("x"), "muted:x");
});

test("buildSettingsListTheme mirrors pi's own settings-list role mapping (accent/muted/dim)", () => {
  const theme = buildSettingsListTheme(fakeTheme());
  assert.equal(theme.label("x", true), "accent:x");
  assert.equal(theme.label("x", false), "x");
  assert.equal(theme.value("x", true), "accent:x");
  assert.equal(theme.value("x", false), "muted:x");
  assert.equal(theme.description("x"), "dim:x");
  assert.equal(theme.hint("x"), "dim:x");
  assert.equal(theme.cursor, "accent:→ ");
});
