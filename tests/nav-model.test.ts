import { test } from "node:test";
import assert from "node:assert/strict";
import { SCREENS, buildTabBar, screenForKey } from "../src/domain/nav-model.ts";

test("SCREENS lists the four screens in order with their switch key", () => {
  assert.deepEqual(
    SCREENS.map((screen) => [screen.key, screen.id, screen.label]),
    [
      ["1", "today", "Today"],
      ["2", "tasks", "Tasks"],
      ["3", "catalog", "Catalog"],
      ["4", "sync", "Sync"],
    ],
  );
});

test("screenForKey maps a tab-bar digit to its screen id", () => {
  assert.equal(screenForKey("1"), "today");
  assert.equal(screenForKey("2"), "tasks");
  assert.equal(screenForKey("3"), "catalog");
  assert.equal(screenForKey("4"), "sync");
});

test("screenForKey returns undefined for any other key", () => {
  assert.equal(screenForKey("q"), undefined);
  assert.equal(screenForKey("r"), undefined);
  assert.equal(screenForKey("5"), undefined);
});

test("buildTabBar marks exactly the active screen and keeps the fixed order", () => {
  const items = buildTabBar("catalog");
  assert.deepEqual(
    items.map((item) => item.id),
    ["today", "tasks", "catalog", "sync"],
  );
  assert.deepEqual(
    items.map((item) => item.active),
    [false, false, true, false],
  );
  assert.deepEqual(
    items.map((item) => item.text),
    ["1 Today", "2 Tasks", "3 Catalog", "4 Sync"],
  );
});
