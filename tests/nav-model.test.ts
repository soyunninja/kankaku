import { test } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_NAV_STATE, SCREENS, buildTabBar, clearProjectFilter, openProjectInTasks, screenForKey, switchScreen } from "../src/domain/nav-model.ts";

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

test("INITIAL_NAV_STATE starts on Today with no project filter", () => {
  assert.deepEqual(INITIAL_NAV_STATE, { screen: "today" });
});

test("switchScreen changes the active screen and keeps the project filter", () => {
  const withFilter = { screen: "today" as const, projectFilter: "kankaku" };
  assert.deepEqual(switchScreen(withFilter, "catalog"), { screen: "catalog", projectFilter: "kankaku" });
});

test("openProjectInTasks switches to Tasks and sets the project filter", () => {
  assert.deepEqual(openProjectInTasks(INITIAL_NAV_STATE, "kankaku-tui"), { screen: "tasks", projectFilter: "kankaku-tui" });
});

test("clearProjectFilter drops the filter and keeps the current screen", () => {
  const state = { screen: "tasks" as const, projectFilter: "kankaku-tui" };
  assert.deepEqual(clearProjectFilter(state), { screen: "tasks" });
});
