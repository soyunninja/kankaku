import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { HeaderBar } from "../src/ui/components/header-bar.tsx";

test("renders the app name on the left and the status text on the right", () => {
  const { lastFrame } = render(<HeaderBar left=">_ kankaku 0.1.0" right="hub kankaku.soyun.ninja" width={60} />);
  const line = (lastFrame() ?? "").split("\n")[0] ?? "";
  assert.equal(line.startsWith(">_ kankaku 0.1.0"), true);
  assert.equal(line.includes("hub kankaku.soyun.ninja"), true);
});

test("renders with no right text without crashing", () => {
  const { lastFrame } = render(<HeaderBar left=">_ kankaku 0.1.0" width={40} />);
  assert.equal((lastFrame() ?? "").includes(">_ kankaku 0.1.0"), true);
});
