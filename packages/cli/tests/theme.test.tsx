import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Text } from "ink";
import {
  DEFAULT_THEME,
  GENTLE_THEME,
  GENTLEMAN_CUTE_THEME,
  GENTLEMAN_SEXY_THEME,
  THEME_NAMES,
  THEMES,
  ThemeProvider,
  resolveTheme,
  useTheme,
} from "../src/ui/theme.ts";

function Probe() {
  const theme = useTheme();
  return <Text>{theme.accent}</Text>;
}

const ROLES = ["accent", "border", "borderActive", "text", "muted", "dim", "ok", "warn", "error", "selectionBg"] as const;

test("useTheme without a provider returns the default preset", () => {
  const { lastFrame } = render(<Probe />);
  assert.equal(lastFrame(), DEFAULT_THEME.accent);
});

test("ThemeProvider overrides the preset for its subtree", () => {
  const custom = { ...DEFAULT_THEME, accent: "magenta" };
  const { lastFrame } = render(
    <ThemeProvider theme={custom}>
      <Probe />
    </ThemeProvider>,
  );
  assert.equal(lastFrame(), "magenta");
});

test("DEFAULT_THEME defines every colour role", () => {
  for (const role of ROLES) {
    assert.equal(typeof DEFAULT_THEME[role], "string");
  }
});

test("DEFAULT_THEME is the gentleman-sexy preset", () => {
  assert.deepEqual(DEFAULT_THEME, GENTLEMAN_SEXY_THEME);
});

test("every named preset defines every colour role", () => {
  for (const name of THEME_NAMES) {
    for (const role of ROLES) {
      assert.equal(typeof THEMES[name][role], "string", `${name}.${role}`);
    }
  }
});

test("the gentleman-sexy preset matches the owner's pi theme's resolved hex values", () => {
  assert.deepEqual(GENTLEMAN_SEXY_THEME, {
    accent: "#F43888",
    border: "#563040",
    borderActive: "#FF4F9A",
    text: "#F6EFF3",
    muted: "#A78E9B",
    dim: "#76616B",
    ok: "#D2CBD0",
    warn: "#F2B86D",
    error: "#FF718F",
    selectionBg: "#28121E",
  });
});

test("the gentleman-cute preset matches the owner's pi theme's resolved hex values", () => {
  assert.deepEqual(GENTLEMAN_CUTE_THEME, {
    accent: "#F095C8",
    border: "#563040",
    borderActive: "#FFB1DD",
    text: "#F6EFF3",
    muted: "#A78E9B",
    dim: "#76616B",
    ok: "#B4E7C7",
    warn: "#F2B86D",
    error: "#FF718F",
    selectionBg: "#28121E",
  });
});

test("the gentle preset matches the owner's pi theme's resolved hex values", () => {
  assert.deepEqual(GENTLE_THEME, {
    accent: "#7FB4CA",
    border: "#313342",
    borderActive: "#7FB4CA",
    text: "#F3F6F9",
    muted: "#5C6170",
    dim: "#5C6170",
    ok: "#B7CC85",
    warn: "#DEBA87",
    error: "#CB7C94",
    selectionBg: "#232A40",
  });
});

test("resolveTheme returns the named preset for a known name", () => {
  const result = resolveTheme("gentle");
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.theme, GENTLE_THEME);
});

test("resolveTheme fails with a usage error listing every valid name for an unknown name", () => {
  const result = resolveTheme("bogus");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /bogus/);
    for (const name of THEME_NAMES) {
      assert.match(result.reason, new RegExp(name));
    }
  }
});
