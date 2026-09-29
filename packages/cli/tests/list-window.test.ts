import { test } from "node:test";
import assert from "node:assert/strict";
import { windowRows } from "../src/domain/list-window.ts";

test("when everything fits, the window covers all rows and nothing is hidden", () => {
  const result = windowRows(5, 2, 10);
  assert.deepEqual(result, { start: 0, end: 5, hiddenAbove: 0, hiddenBelow: 0 });
});

test("selection at the top keeps the window at the start", () => {
  const result = windowRows(40, 0, 10);
  assert.deepEqual(result, { start: 0, end: 10, hiddenAbove: 0, hiddenBelow: 30 });
});

test("selection at the bottom pins the window to the end", () => {
  const result = windowRows(40, 39, 10);
  assert.deepEqual(result, { start: 30, end: 40, hiddenAbove: 30, hiddenBelow: 0 });
});

test("selection moving within the previous window keeps the start stable", () => {
  const result = windowRows(40, 20, 10, 15);
  assert.deepEqual(result, { start: 15, end: 25, hiddenAbove: 15, hiddenBelow: 15 });
});

test("selection moving above the previous window scrolls up to reveal it", () => {
  const result = windowRows(40, 8, 10, 15);
  assert.deepEqual(result, { start: 8, end: 18, hiddenAbove: 8, hiddenBelow: 22 });
});

test("selection moving below the previous window scrolls down to reveal it", () => {
  const result = windowRows(40, 24, 10, 0);
  assert.deepEqual(result, { start: 15, end: 25, hiddenAbove: 15, hiddenBelow: 15 });
});

test("tiny maxRows still tracks the selection with a one-row window", () => {
  const result = windowRows(5, 2, 1);
  assert.deepEqual(result, { start: 2, end: 3, hiddenAbove: 2, hiddenBelow: 2 });
});

test("maxRows of zero collapses to an empty window", () => {
  const result = windowRows(5, 2, 0);
  assert.deepEqual(result, { start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 });
});

test("an out-of-range selection is clamped before windowing", () => {
  const result = windowRows(10, 99, 4);
  assert.deepEqual(result, { start: 6, end: 10, hiddenAbove: 6, hiddenBelow: 0 });
});
