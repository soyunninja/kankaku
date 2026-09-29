import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_NAV_STATE,
  SCREENS,
  buildTabBar,
  clearProjectFilter,
  focusMain,
  focusSidebar,
  hintsFor,
  moveSidebar,
  openProjectInTasks,
  screenForKey,
  setModal,
  switchScreen,
} from "../src/domain/nav-model.ts";

test("SCREENS lists the four screens in order with their switch key", () => {
  assert.deepEqual(
    SCREENS.map((screen) => [screen.key, screen.id, screen.label]),
    [
      ["1", "dashboard", "Dashboard"],
      ["2", "tasks", "Tasks"],
      ["3", "catalog", "Catalog"],
      ["4", "sync", "Sync"],
    ],
  );
});

test("screenForKey maps a tab-bar digit to its screen id", () => {
  assert.equal(screenForKey("1"), "dashboard");
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
    ["dashboard", "tasks", "catalog", "sync"],
  );
  assert.deepEqual(
    items.map((item) => item.active),
    [false, false, true, false],
  );
  assert.deepEqual(
    items.map((item) => item.text),
    ["1 Dashboard", "2 Tasks", "3 Catalog", "4 Sync"],
  );
});

test("INITIAL_NAV_STATE starts on Dashboard, focused on the sidebar, with no project filter", () => {
  assert.deepEqual(INITIAL_NAV_STATE, { screen: "dashboard", focus: "sidebar" });
});

test("switchScreen changes the active screen and keeps the project filter and focus", () => {
  const withFilter = { screen: "dashboard" as const, focus: "main" as const, projectFilter: "kankaku" };
  assert.deepEqual(switchScreen(withFilter, "catalog"), { screen: "catalog", focus: "main", projectFilter: "kankaku" });
});

test("openProjectInTasks switches to Tasks, sets the project filter and keeps focus", () => {
  assert.deepEqual(openProjectInTasks(INITIAL_NAV_STATE, "kankaku-tui"), { screen: "tasks", focus: "sidebar", projectFilter: "kankaku-tui" });
  const mainFocused = { screen: "dashboard" as const, focus: "main" as const };
  assert.deepEqual(openProjectInTasks(mainFocused, "kankaku-tui"), { screen: "tasks", focus: "main", projectFilter: "kankaku-tui" });
});

test("clearProjectFilter drops the filter and keeps the current screen and focus", () => {
  const state = { screen: "tasks" as const, focus: "main" as const, projectFilter: "kankaku-tui" };
  assert.deepEqual(clearProjectFilter(state), { screen: "tasks", focus: "main" });
});

test("focusMain switches focus to the main zone, keeping the rest of the state", () => {
  const state = { screen: "tasks" as const, focus: "sidebar" as const, projectFilter: "kankaku" };
  assert.deepEqual(focusMain(state), { screen: "tasks", focus: "main", projectFilter: "kankaku" });
});

test("focusSidebar switches focus to the sidebar, keeping the rest of the state", () => {
  const state = { screen: "tasks" as const, focus: "main" as const, projectFilter: "kankaku" };
  assert.deepEqual(focusSidebar(state), { screen: "tasks", focus: "sidebar", projectFilter: "kankaku" });
});

test("moveSidebar steps to the next/previous screen in SCREENS order", () => {
  const state = { screen: "tasks" as const, focus: "sidebar" as const };
  assert.deepEqual(moveSidebar(state, 1), { screen: "catalog", focus: "sidebar" });
  assert.deepEqual(moveSidebar(state, -1), { screen: "dashboard", focus: "sidebar" });
});

test("moveSidebar clamps at the first and last screen instead of wrapping", () => {
  const first = { screen: "dashboard" as const, focus: "sidebar" as const };
  assert.deepEqual(moveSidebar(first, -1), first);
  const last = { screen: "sync" as const, focus: "sidebar" as const };
  assert.deepEqual(moveSidebar(last, 1), last);
});

test("moveSidebar keeps an existing project filter", () => {
  const state = { screen: "dashboard" as const, focus: "sidebar" as const, projectFilter: "kankaku" };
  assert.deepEqual(moveSidebar(state, 1), { screen: "tasks", focus: "sidebar", projectFilter: "kankaku" });
});

test("hintsFor returns the fixed sidebar hints when the sidebar is focused, regardless of extras", () => {
  const extras = [{ key: "a", label: "today/all" }];
  assert.deepEqual(hintsFor("tasks", "sidebar", extras), [
    { key: "↑↓", label: "choose" },
    { key: "enter/→", label: "open" },
    { key: "1-4", label: "screens" },
    { key: "q", label: "quit" },
  ]);
});

test("hintsFor appends '← menu' to the screen's own hints when the main zone is focused", () => {
  const extras = [
    { key: "↑↓", label: "select" },
    { key: "r", label: "refresh" },
  ];
  assert.deepEqual(hintsFor("catalog", "main", extras), [
    { key: "↑↓", label: "select" },
    { key: "r", label: "refresh" },
    { key: "←", label: "menu" },
  ]);
});

test("setModal marks the state modal and clears the mark again, keeping the rest", () => {
  const state = { screen: "tasks" as const, focus: "main" as const, projectFilter: "kankaku" };
  const open = setModal(state, true);
  assert.deepEqual(open, { ...state, modal: true });
  assert.deepEqual(setModal(open, false), state);
  assert.equal("modal" in setModal(open, false), false);
});
