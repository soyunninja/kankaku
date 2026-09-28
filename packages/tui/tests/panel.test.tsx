import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { Panel } from "../src/ui/components/panel.tsx";

test("renders the title inside the top border and the content below", () => {
  const { lastFrame } = render(
    <Panel title="Today" width={20}>
      <Text>hello</Text>
    </Panel>,
  );
  const frame = lastFrame() ?? "";
  const lines = frame.split("\n");
  assert.equal(lines[0]?.startsWith("╭─[ Today ]"), true);
  assert.equal(lines[0]?.endsWith("╮"), true);
  assert.equal(lines[0]?.length, 20);
  assert.equal(frame.includes("hello"), true);
  assert.equal(frame.includes("╰"), true);
});

test("renders an optional right-aligned header before the closing corner", () => {
  const { lastFrame } = render(
    <Panel title="Today" width={30} headerRight="hub ok">
      <Text>x</Text>
    </Panel>,
  );
  const line = (lastFrame() ?? "").split("\n")[0] ?? "";
  assert.equal(line.includes("hub ok"), true);
  assert.equal(line.endsWith("hub ok ╮") || line.endsWith("hub ok╮"), true);
});

test("stays bounded even when the title is wider than the given width", () => {
  const { lastFrame } = render(
    <Panel title="A very long panel title indeed" width={10}>
      <Text>x</Text>
    </Panel>,
  );
  const line = (lastFrame() ?? "").split("\n")[0] ?? "";
  assert.equal(line.startsWith("╭─[ A very long panel title indeed ]"), true);
  assert.equal(line.endsWith("╮"), true);
});

test("active accepts a boolean flag without breaking rendering", () => {
  const { lastFrame } = render(
    <Panel title="Today" width={20} active>
      <Text>hello</Text>
    </Panel>,
  );
  assert.equal((lastFrame() ?? "").includes("hello"), true);
});

test("a fixed height clips overflowing children instead of growing past it", () => {
  const { lastFrame } = render(
    <Panel title="Tasks" width={20} height={5}>
      <Text>{"one\ntwo\nthree\nfour\nfive\nsix\nseven"}</Text>
    </Panel>,
  );
  const lines = (lastFrame() ?? "").split("\n");
  // 1 top border + 1 bottom border + up to 3 content lines = 5 total lines.
  assert.equal(lines.length, 5);
  assert.equal(lines.join("\n").includes("seven"), false);
});

test("flexGrow is accepted without breaking rendering", () => {
  const { lastFrame } = render(
    <Panel title="Today" width={20} flexGrow={1}>
      <Text>hello</Text>
    </Panel>,
  );
  assert.equal((lastFrame() ?? "").includes("hello"), true);
});
