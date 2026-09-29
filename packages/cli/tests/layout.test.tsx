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

test("a forced `rows` puts the footer on the last line of the frame", () => {
  const { lastFrame } = render(
    <Layout columns={120} rows={12} headerLeft=">_ kankaku" sidebarItems={sidebarItems} activeId="today" sidebarStats={["roots 1"]} keyHints={keyHints}>
      {({ mainHeight }) => <Text>{`height:${mainHeight}`}</Text>}
    </Layout>,
  );
  const lines = (lastFrame() ?? "").split("\n");
  assert.equal(lines.length, 12);
  assert.equal(lines[0]?.includes(">_ kankaku"), true);
  assert.equal(lines[lines.length - 1]?.includes("q quit"), true);
});

test("`mainHeight` shrinks and the footer still lands on the last line after a taller re-render", () => {
  const { lastFrame, rerender } = render(
    <Layout columns={120} rows={20} headerLeft=">_ kankaku" sidebarItems={sidebarItems} activeId="today" sidebarStats={["roots 1"]} keyHints={keyHints}>
      {({ mainHeight }) => <Text>{`height:${mainHeight}`}</Text>}
    </Layout>,
  );
  const firstLines = (lastFrame() ?? "").split("\n");
  assert.equal(firstLines.length, 20);
  assert.equal(firstLines[firstLines.length - 1]?.includes("q quit"), true);
  assert.equal((lastFrame() ?? "").includes("height:18"), true);

  rerender(
    <Layout columns={120} rows={30} headerLeft=">_ kankaku" sidebarItems={sidebarItems} activeId="today" sidebarStats={["roots 1"]} keyHints={keyHints}>
      {({ mainHeight }) => <Text>{`height:${mainHeight}`}</Text>}
    </Layout>,
  );
  const secondLines = (lastFrame() ?? "").split("\n");
  assert.equal(secondLines.length, 30);
  assert.equal(secondLines[secondLines.length - 1]?.includes("q quit"), true);
  assert.equal((lastFrame() ?? "").includes("height:28"), true);
});

test("in stacked mode, `mainHeight` accounts for the sidebar block's own rows", () => {
  const { lastFrame } = render(
    <Layout columns={80} rows={20} headerLeft=">_ kankaku" sidebarItems={sidebarItems} activeId="today" sidebarStats={["roots 1"]} keyHints={keyHints}>
      {({ mainHeight }) => <Text>{`height:${mainHeight}`}</Text>}
    </Layout>,
  );
  const frame = lastFrame() ?? "";
  // 20 rows - 1 header - 1 footer - sidebar block (2 items + 1 divider + 1 stat + 2 border = 6) = 12.
  assert.equal(frame.includes("height:12"), true);
});

test("a footer note replaces the key hints on the same single footer line", () => {
  const { lastFrame } = render(
    <Layout columns={120} rows={12} headerLeft=">_ kankaku" sidebarItems={sidebarItems} activeId="today" sidebarStats={["roots 1"]} keyHints={keyHints} footerNote="asking the hub…">
      {() => <Text>main</Text>}
    </Layout>,
  );
  const lines = (lastFrame() ?? "").split("\n");
  assert.equal(lines.length, 12);
  assert.equal(lines[lines.length - 1]?.includes("asking the hub…"), true);
  assert.equal(lines[lines.length - 1]?.includes("q quit"), false);
});
