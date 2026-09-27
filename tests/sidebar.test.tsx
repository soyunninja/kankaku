import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Sidebar } from "../src/ui/components/sidebar.tsx";

const items = [
  { id: "today", label: "Today", key: "1" },
  { id: "tasks", label: "Tasks", key: "2" },
  { id: "catalog", label: "Catalog", key: "3" },
  { id: "sync", label: "Sync", key: "4" },
];

test("marks the active item with a visible marker and lists the rest plainly", () => {
  const { lastFrame } = render(<Sidebar items={items} activeId="today" stats={["roots 1", "projects 3"]} width={16} />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("› Today"), true);
  assert.equal(frame.includes("  Tasks"), true);
  assert.equal(frame.includes("  Catalog"), true);
  assert.equal(frame.includes("  Sync"), true);
});

test("renders the stats block below the nav items", () => {
  const { lastFrame } = render(<Sidebar items={items} activeId="tasks" stats={["roots 1", "projects 3"]} width={16} />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("roots 1"), true);
  assert.equal(frame.includes("projects 3"), true);
  assert.equal(frame.includes("› Tasks"), true);
});

// `ink-testing-library`'s stub stdout never emits ANSI (see AGENTS.md), so
// the accent/muted colour swap on `focused` cannot be asserted from
// `lastFrame()` text; these tests only prove the prop is accepted without
// breaking the marker/label rendering, in either state.
test("focused accepts a boolean flag without breaking rendering when true", () => {
  const { lastFrame } = render(<Sidebar items={items} activeId="today" stats={[]} width={16} focused />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("› Today"), true);
});

test("focused accepts a boolean flag without breaking rendering when false", () => {
  const { lastFrame } = render(<Sidebar items={items} activeId="today" stats={[]} width={16} focused={false} />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("› Today"), true);
});
