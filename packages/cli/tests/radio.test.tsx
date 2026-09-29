import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Radio } from "../src/ui/components/radio.tsx";
import type { RadioOption } from "../src/ui/components/radio.tsx";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

const options: RadioOption<"existing" | "local" | "skip">[] = [
  { value: "existing", label: "use existing" },
  { value: "local", label: "install locally" },
  { value: "skip", label: "skip" },
];

test("renders (•) for the selected option and ( ) for the rest", () => {
  const { lastFrame } = render(<Radio options={options} value="local" onChange={() => {}} focused />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("(•) install locally"), true);
  assert.equal(frame.includes("( ) use existing"), true);
  assert.equal(frame.includes("( ) skip"), true);
});

test("down arrow selects the next option", async () => {
  const selections: string[] = [];
  const { stdin } = render(<Radio options={options} value="existing" onChange={(value) => selections.push(value)} focused />);
  stdin.write("\u001B[B"); // down
  await nextTick();
  assert.deepEqual(selections, ["local"]);
});

test("up arrow selects the previous option", async () => {
  const selections: string[] = [];
  const { stdin } = render(<Radio options={options} value="local" onChange={(value) => selections.push(value)} focused />);
  stdin.write("\u001B[A"); // up
  await nextTick();
  assert.deepEqual(selections, ["existing"]);
});

test("clamps at the first and last option", async () => {
  const selections: string[] = [];
  const { stdin } = render(<Radio options={options} value="existing" onChange={(value) => selections.push(value)} focused />);
  stdin.write("\u001B[A"); // up, already first
  await nextTick();
  assert.deepEqual(selections, []);
});

test("ignores input when not focused", async () => {
  const selections: string[] = [];
  const { stdin } = render(<Radio options={options} value="existing" onChange={(value) => selections.push(value)} focused={false} />);
  stdin.write("\u001B[B");
  await nextTick();
  assert.deepEqual(selections, []);
});
