import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapText } from "../src/domain/text-wrap.ts";

test("wraps at word boundaries without exceeding the given width", () => {
  const lines = wrapText("the quick brown fox jumps over the lazy dog", 10);
  for (const line of lines) {
    assert.ok(line.length <= 10, `line "${line}" exceeds width 10`);
  }
  assert.equal(lines.join(" "), "the quick brown fox jumps over the lazy dog");
});

test("hard-breaks a single word longer than the width", () => {
  const lines = wrapText("supercalifragilisticexpialidocious", 10);
  for (const line of lines) {
    assert.ok(line.length <= 10, `line "${line}" exceeds width 10`);
  }
  assert.equal(lines.join(""), "supercalifragilisticexpialidocious");
});

test("keeps explicit newlines as separate wrap groups", () => {
  const lines = wrapText("first line\nsecond line", 40);
  assert.deepEqual(lines, ["first line", "second line"]);
});

test("preserves an empty line for consecutive newlines", () => {
  const lines = wrapText("a\n\nb", 40);
  assert.deepEqual(lines, ["a", "", "b"]);
});

test("a short single-line text wraps to exactly one line", () => {
  assert.deepEqual(wrapText("short prompt", 80), ["short prompt"]);
});

test("empty text wraps to one empty line", () => {
  assert.deepEqual(wrapText("", 10), [""]);
});

test("a width of 0 or less is treated as 1 to avoid an infinite loop", () => {
  const lines = wrapText("abc", 0);
  assert.deepEqual(lines, ["a", "b", "c"]);
});

test("a very long prompt (3000 characters) wraps to many lines, all within the width", () => {
  const text = "word ".repeat(600).trim();
  const lines = wrapText(text, 30);
  assert.ok(lines.length > 50, `expected many lines, got ${lines.length}`);
  for (const line of lines) {
    assert.ok(line.length <= 30, `line "${line}" exceeds width 30`);
  }
});
