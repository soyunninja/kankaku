import { test } from "node:test";
import assert from "node:assert/strict";
import { QUICK_ACTIONS, formatQuickActionLines } from "../src/domain/quick-actions.ts";
import type { QuickActionState } from "../src/domain/quick-actions.ts";

test("QUICK_ACTIONS lists the four actions with their key and label, in order", () => {
  assert.deepEqual(QUICK_ACTIONS, [
    { key: "c", label: "refresh catalog" },
    { key: "s", label: "sync all projects" },
    { key: "S", label: "full sync all" },
    { key: "r", label: "reload" },
  ]);
});

test("formatQuickActionLines returns an empty status line when idle", () => {
  assert.deepEqual(formatQuickActionLines(40, { status: "idle" }), [""]);
});

test("formatQuickActionLines shows a busy marker with the running action's label", () => {
  assert.deepEqual(formatQuickActionLines(40, { status: "busy", key: "c" }), ["… refresh catalog"]);
  assert.deepEqual(formatQuickActionLines(40, { status: "busy", key: "S" }), ["… full sync all"]);
});

test("formatQuickActionLines shows the settled result message when done", () => {
  const state: QuickActionState = { status: "done", key: "c", message: "catalog: 9 clients · 17 projects · 42 tasks" };
  assert.deepEqual(formatQuickActionLines(60, state), ["catalog: 9 clients · 17 projects · 42 tasks"]);
});

test("formatQuickActionLines shows the unavailable reason verbatim", () => {
  const state: QuickActionState = { status: "unavailable", reason: "hub not configured (~/.kankaku/credentials.json)" };
  assert.deepEqual(formatQuickActionLines(60, state), ["hub not configured (~/.kankaku/credentials.json)"]);
});

test("formatQuickActionLines truncates a status line to fit width, keeping the line count at one", () => {
  const state: QuickActionState = { status: "done", key: "s", message: "a very long sync summary that will not fit in a narrow panel width" };
  const lines = formatQuickActionLines(20, state);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length <= 20, `expected at most 20 chars, got ${lines[0].length}`);
  assert.ok(lines[0].endsWith("…"));
});

test("formatQuickActionLines never overflows even at a width of zero or negative", () => {
  const state: QuickActionState = { status: "done", key: "r", message: "reloaded" };
  assert.equal(formatQuickActionLines(0, state)[0].length, 1);
  assert.equal(formatQuickActionLines(-5, state)[0].length, 1);
});
