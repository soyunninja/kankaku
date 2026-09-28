import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Bar, renderBar } from "../src/ui/components/bar.tsx";

test("renders a full bar at value === max", () => {
  const { lastFrame } = render(<Bar value={10} max={10} width={10} />);
  assert.equal(lastFrame(), "██████████");
});

test("renders an empty bar at value 0", () => {
  const { lastFrame } = render(<Bar value={0} max={10} width={10} />);
  assert.equal(lastFrame(), "░░░░░░░░░░");
});

test("renders a partial bar proportionally", () => {
  const { lastFrame } = render(<Bar value={5} max={10} width={10} />);
  assert.equal(lastFrame(), "█████░░░░░");
});

test("a zero max never divides by zero", () => {
  const { lastFrame } = render(<Bar value={0} max={0} width={4} />);
  assert.equal(lastFrame(), "░░░░");
});

test("renderBar returns the same plain-text bar the component renders", () => {
  const text = renderBar(5, 10, 10);
  assert.equal(text, "█████░░░░░");
});
