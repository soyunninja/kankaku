import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { Layout } from "../src/ui/layout.tsx";

const sidebarItems = [
  { id: "today", label: "Today", key: "1" },
  { id: "tasks", label: "Tasks", key: "2" },
];
const keyHints = [{ key: "q", label: "quit" }];

test("wide layout (>=100 cols) shows the full sidebar beside main content", () => {
  const { lastFrame } = render(
    <Layout
      columns={120}
      headerLeft=">_ kankaku"
      sidebarItems={sidebarItems}
      activeId="today"
      sidebarStats={["roots 1"]}
      keyHints={keyHints}
    >
      {({ mainWidth }) => <Text>{`main:${mainWidth}`}</Text>}
    </Layout>,
  );
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("› Today"), true);
  assert.equal(frame.includes("main:104"), true);
  assert.equal(frame.includes("q quit"), true);
});

test("stacked layout (70-99 cols) puts the full-width sidebar above main content", () => {
  const { lastFrame } = render(
    <Layout columns={80} headerLeft=">_ kankaku" sidebarItems={sidebarItems} activeId="tasks" sidebarStats={["roots 1"]} keyHints={keyHints}>
      {({ mainWidth }) => <Text>{`main:${mainWidth}`}</Text>}
    </Layout>,
  );
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("› Tasks"), true);
  assert.equal(frame.includes("main:80"), true);
});

test("collapsed layout (<70 cols) shows a one-line tab strip instead of the sidebar box", () => {
  const { lastFrame } = render(
    <Layout columns={60} headerLeft=">_ kankaku" sidebarItems={sidebarItems} activeId="today" sidebarStats={["roots 1"]} keyHints={keyHints}>
      {({ mainWidth }) => <Text>{`main:${mainWidth}`}</Text>}
    </Layout>,
  );
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("[Today]"), true);
  assert.equal(frame.includes("Tasks"), true);
  assert.equal(frame.includes("main:60"), true);
  assert.equal(frame.includes("roots 1"), false);
});
