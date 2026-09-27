import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Checklist } from "../src/ui/components/checklist.tsx";
import type { ChecklistItem } from "../src/ui/components/checklist.tsx";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function items(): ChecklistItem[] {
  return [
    { id: "pi", label: "pi", checked: true },
    { id: "gentle-shell", label: "gentle-shell", checked: false },
    { id: "claude-code", label: "Claude Code", checked: false },
    { id: "codex", label: "Codex", checked: false, disabled: true, note: "no adapter yet" },
  ];
}

test("renders [x]/[ ]/[-] per item, with the note for a disabled row", () => {
  const { lastFrame } = render(<Checklist items={items()} cursor={0} onToggle={() => {}} onMove={() => {}} focused />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("[x] pi"), true);
  assert.equal(frame.includes("[ ] gentle-shell"), true);
  assert.equal(frame.includes("[ ] Claude Code"), true);
  assert.equal(frame.includes("[-] Codex (no adapter yet)"), true);
});

test("marks the cursor row with a visible '›' marker", () => {
  const { lastFrame } = render(<Checklist items={items()} cursor={1} onToggle={() => {}} onMove={() => {}} focused />);
  const lines = (lastFrame() ?? "").split("\n");
  assert.equal(lines[0]?.startsWith("  "), true);
  assert.equal(lines[1]?.startsWith("› "), true);
});

test("space toggles the item at the cursor", async () => {
  const toggled: string[] = [];
  const { stdin } = render(<Checklist items={items()} cursor={0} onToggle={(id) => toggled.push(id)} onMove={() => {}} focused />);
  stdin.write(" ");
  await nextTick();
  assert.deepEqual(toggled, ["pi"]);
});

test("space does not toggle a disabled row", async () => {
  const toggled: string[] = [];
  const { stdin } = render(<Checklist items={items()} cursor={3} onToggle={(id) => toggled.push(id)} onMove={() => {}} focused />);
  stdin.write(" ");
  await nextTick();
  assert.deepEqual(toggled, []);
});

test("up/down arrows call onMove with -1/1", async () => {
  const moves: number[] = [];
  const { stdin } = render(<Checklist items={items()} cursor={1} onToggle={() => {}} onMove={(delta) => moves.push(delta)} focused />);
  stdin.write("\u001B[B"); // down
  await nextTick();
  stdin.write("\u001B[A"); // up
  await nextTick();
  assert.deepEqual(moves, [1, -1]);
});

test("ignores input entirely when not focused", async () => {
  const toggled: string[] = [];
  const moves: number[] = [];
  const { stdin } = render(<Checklist items={items()} cursor={0} onToggle={(id) => toggled.push(id)} onMove={(delta) => moves.push(delta)} focused={false} />);
  stdin.write(" ");
  stdin.write("\u001B[B");
  await nextTick();
  assert.deepEqual(toggled, []);
  assert.deepEqual(moves, []);
});
