import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTargetRows,
  footerHints,
  navBack,
  navCurrent,
  navPush,
  navRoot,
  panelTitle,
  rootMenu,
} from "../src/domain/panel-model.ts";
import type { PanelScreenId } from "../src/domain/panel-model.ts";
import type { WorkTarget } from "../src/domain/work-target.ts";

test("rootMenu lists every screen, in order, when the hub is configured", () => {
  const items = rootMenu({ hubConfigured: true });
  assert.deepEqual(
    items.map((item) => item.id),
    ["target", "report", "sync", "export", "doctor", "about"],
  );
  // target is NOT hub-only: the legacy `/kankaku client <name>` label lives on
  // this same screen and works with no hub configured at all.
  assert.equal(items.find((item) => item.id === "target")!.hubOnly, false);
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

test("rootMenu omits only hubOnly items (sync) when the hub is not configured; target stays", () => {
  const items = rootMenu({ hubConfigured: false });
  assert.deepEqual(
    items.map((item) => item.id),
    ["target", "report", "export", "doctor", "about"],
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

const CLIENT_ONLY_TARGET: WorkTarget = { clientId: "c-acme", clientCode: "acme", clientName: "Acme" };
const FULL_TARGET: WorkTarget = {
  clientId: "c-acme",
  clientCode: "acme",
  clientName: "Acme",
  projectId: "p-portal",
  projectName: "Portal",
  hubTaskId: "t-1",
  hubTaskTitle: "Fix the thing",
};

test("buildTargetRows without the hub configured only shows the legacy row", () => {
  const rows = buildTargetRows({ hubConfigured: false, legacyLabel: "acme", legacySource: "session" });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["legacy"],
  );
  assert.equal(rows[0]!.value, "acme");
  assert.equal(rows[0]!.description, "Source: session");
});

test("buildTargetRows with the hub configured and no target: every row shows '— none —' with the right hints", () => {
  const rows = buildTargetRows({ hubConfigured: true });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["client", "project", "task", "source", "remember", "legacy"],
  );
  assert.equal(rows.find((row) => row.id === "client")!.value, "— none —");
  const project = rows.find((row) => row.id === "project")!;
  assert.equal(project.value, "— none —");
  assert.equal(project.description, "pick a client first");
  const task = rows.find((row) => row.id === "task")!;
  assert.equal(task.value, "— none —");
  assert.equal(task.description, "pick a project first");
  assert.equal(rows.find((row) => row.id === "source")!.value, "none");
  assert.equal(rows.find((row) => row.id === "remember")!.value, "save to config.json");
  assert.match(rows.find((row) => row.id === "remember")!.description!, /clientId.*projectId|clientProject|project/i);
  assert.equal(rows.find((row) => row.id === "legacy")!.value, "— none —");
});

test("buildTargetRows with a client but no project: project has no hint, task points at the project", () => {
  const rows = buildTargetRows({ hubConfigured: true, target: CLIENT_ONLY_TARGET, source: "session" });
  assert.equal(rows.find((row) => row.id === "client")!.value, "Acme (acme)");
  const project = rows.find((row) => row.id === "project")!;
  assert.equal(project.value, "— none —");
  assert.equal(project.description, undefined);
  const task = rows.find((row) => row.id === "task")!;
  assert.equal(task.value, "— none —");
  assert.equal(task.description, "pick a project first");
  assert.equal(rows.find((row) => row.id === "source")!.value, "session");
});

test("buildTargetRows with a full target: client/project/task show their values, no 'pick first' hints", () => {
  const rows = buildTargetRows({ hubConfigured: true, target: FULL_TARGET, source: "config" });
  assert.equal(rows.find((row) => row.id === "client")!.value, "Acme (acme)");
  const project = rows.find((row) => row.id === "project")!;
  assert.equal(project.value, "Portal");
  assert.equal(project.description, undefined);
  const task = rows.find((row) => row.id === "task")!;
  assert.equal(task.value, "Fix the thing");
  assert.equal(task.description, undefined);
  assert.equal(rows.find((row) => row.id === "source")!.value, "config");
});
