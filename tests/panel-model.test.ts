import assert from "node:assert/strict";
import { test } from "node:test";
import {
  footerHints,
  navBack,
  navCurrent,
  navPush,
  navRoot,
  panelTitle,
  rootMenu,
} from "../src/domain/panel-model.ts";
import type { PanelScreenId } from "../src/domain/panel-model.ts";

test("rootMenu lists every screen, in order, when the hub is configured", () => {
  const items = rootMenu({ hubConfigured: true });
  assert.deepEqual(
    items.map((item) => item.id),
    ["target", "report", "sync", "export", "doctor", "about"],
  );
  assert.equal(items.find((item) => item.id === "target")!.hubOnly, true);
  assert.equal(items.find((item) => item.id === "sync")!.hubOnly, true);
  assert.equal(items.find((item) => item.id === "report")!.hubOnly, false);
  assert.equal(items.find((item) => item.id === "export")!.hubOnly, false);
  assert.equal(items.find((item) => item.id === "doctor")!.hubOnly, false);
  assert.equal(items.find((item) => item.id === "about")!.hubOnly, false);
  for (const item of items) {
    assert.equal(typeof item.label, "string");
    assert.ok(item.label.length > 0);
    assert.equal(typeof item.description, "string");
  }
});

test("rootMenu omits hubOnly items when the hub is not configured", () => {
  const items = rootMenu({ hubConfigured: false });
  assert.deepEqual(
    items.map((item) => item.id),
    ["report", "export", "doctor", "about"],
  );
});

test("navRoot starts at the root screen", () => {
  const nav = navRoot();
  assert.equal(navCurrent(nav), "root");
  assert.deepEqual(nav.stack, ["root"]);
});

test("navPush moves the current screen forward and returns a new immutable nav", () => {
  const root = navRoot();
  const pushed = navPush(root, "report");
  assert.equal(navCurrent(pushed), "report");
  assert.deepEqual(pushed.stack, ["root", "report"]);
  // the original nav is untouched
  assert.deepEqual(root.stack, ["root"]);
});

test("navBack pops the stack and reports closed: false when a screen remains", () => {
  const nested = navPush(navPush(navRoot(), "target"), "report");
  const { nav, closed } = navBack(nested);
  assert.equal(closed, false);
  assert.equal(navCurrent(nav), "target");
  assert.deepEqual(nav.stack, ["root", "target"]);
  // the original nav is untouched
  assert.deepEqual(nested.stack, ["root", "target", "report"]);
});

test("navBack at root reports closed: true and leaves the stack unchanged", () => {
  const root = navRoot();
  const { nav, closed } = navBack(root);
  assert.equal(closed, true);
  assert.deepEqual(nav.stack, ["root"]);
});

test("panelTitle renders 'kankaku' at root and 'kankaku · <Screen>' elsewhere", () => {
  const expectations: Record<PanelScreenId, string> = {
    root: "kankaku",
    target: "kankaku · Target",
    report: "kankaku · Report",
    sync: "kankaku · Sync",
    export: "kankaku · Export",
    doctor: "kankaku · Doctor",
    about: "kankaku · About",
  };
  for (const [screen, title] of Object.entries(expectations)) {
    assert.equal(panelTitle(screen as PanelScreenId), title);
  }
});

test("footerHints at root: move, open, esc close (no search)", () => {
  const hints = footerHints("root", { searchable: false });
  assert.deepEqual(
    hints.map((hint) => hint.key),
    ["↑↓", "enter", "esc"],
  );
  assert.deepEqual(
    hints.map((hint) => hint.label),
    ["move", "open", "close"],
  );
});

test("footerHints at root includes the search hint when searchable", () => {
  const hints = footerHints("root", { searchable: true });
  assert.deepEqual(
    hints.map((hint) => hint.key),
    ["↑↓", "enter", "/", "esc"],
  );
  assert.deepEqual(
    hints.map((hint) => hint.label),
    ["move", "open", "search", "close"],
  );
});

test("footerHints on a non-root screen: move, select, esc back, q close (no search)", () => {
  const hints = footerHints("report", { searchable: false });
  assert.deepEqual(
    hints.map((hint) => hint.key),
    ["↑↓", "enter", "esc", "q"],
  );
  assert.deepEqual(
    hints.map((hint) => hint.label),
    ["move", "select", "back", "close"],
  );
});

test("footerHints on a non-root screen includes the search hint when searchable", () => {
  const hints = footerHints("sync", { searchable: true });
  assert.deepEqual(
    hints.map((hint) => hint.key),
    ["↑↓", "enter", "/", "esc", "q"],
  );
});
