import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { DEFAULT_THEME, ThemeProvider, useTheme } from "../src/ui/theme.ts";

function Probe() {
  const theme = useTheme();
  return <Text>{theme.accent}</Text>;
}

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
  const roles = ["accent", "border", "borderActive", "text", "muted", "ok", "warn", "error", "selectionBg"] as const;
  for (const role of roles) {
    assert.equal(typeof DEFAULT_THEME[role], "string");
  }
});
