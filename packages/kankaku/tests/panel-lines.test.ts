import assert from "node:assert/strict";
import { test } from "node:test";
import { renderBoundedLines } from "../src/adapters/panel/panel-lines.ts";

test("returns every line unchanged when there are fewer than maxLines", () => {
  const lines = ["a", "b", "c"];
  assert.deepEqual(renderBoundedLines(lines, 5), ["a", "b", "c"]);
});

test("returns every line unchanged when there are exactly maxLines", () => {
  const lines = ["a", "b", "c"];
  assert.deepEqual(renderBoundedLines(lines, 3), ["a", "b", "c"]);
});

test("truncates to maxLines and appends a '… N more' footer when there are more", () => {
  const lines = ["a", "b", "c", "d", "e"];
  assert.deepEqual(renderBoundedLines(lines, 3), ["a", "b", "c", "… 2 more"]);
});

test("an empty input stays empty", () => {
  assert.deepEqual(renderBoundedLines([], 5), []);
});
