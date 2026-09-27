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
