import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Sparkline } from "../src/ui/components/sparkline.tsx";

test("renders one block level per value, scaled to the series max", () => {
  const { lastFrame } = render(<Sparkline values={[0, 1, 2, 3, 4, 5, 6, 7]} />);
  assert.equal(lastFrame(), "▁▂▃▄▅▆▇█");
});

test("an all-zero series renders the lowest block, not a crash", () => {
  const { lastFrame } = render(<Sparkline values={[0, 0, 0]} />);
  assert.equal(lastFrame(), "▁▁▁");
});

test("an empty series renders a single middle dot", () => {
  const { lastFrame } = render(<Sparkline values={[]} />);
  assert.equal(lastFrame(), "·");
});
