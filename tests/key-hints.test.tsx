import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { KeyHints } from "../src/ui/components/key-hints.tsx";

test("renders every key/label pair", () => {
  const hints = [
    { key: "↑↓", label: "move" },
    { key: "enter", label: "open" },
    { key: "r", label: "refresh" },
    { key: "q", label: "quit" },
  ];
  const { lastFrame } = render(<KeyHints hints={hints} />);
  const frame = lastFrame() ?? "";
  for (const hint of hints) {
    assert.equal(frame.includes(hint.key), true);
    assert.equal(frame.includes(hint.label), true);
  }
});
