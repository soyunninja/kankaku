import { test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { render } from "ink-testing-library";
import { TextInput } from "../src/ui/components/text-input.tsx";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

/** A small controlled wrapper, mirroring how a real screen would drive `TextInput`. */
function Controlled({ initial = "", masked = false, focused = true, placeholder = "", onSubmit }: { initial?: string; masked?: boolean; focused?: boolean; placeholder?: string; onSubmit?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return <TextInput value={value} onChange={setValue} onSubmit={onSubmit} placeholder={placeholder} masked={masked} focused={focused} />;
}

test("renders the placeholder when empty", () => {
  const { lastFrame } = render(<Controlled placeholder="checkout path" />);
  assert.equal((lastFrame() ?? "").includes("checkout path"), true);
});

test("typing inserts characters at the end when the cursor starts there", async () => {
  const { lastFrame, stdin } = render(<Controlled />);
  stdin.write("a");
  await nextTick();
  stdin.write("b");
  await nextTick();
  stdin.write("c");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("abc"), true);
});

test("shows a visible cursor marker '▏' when focused", async () => {
  const { lastFrame, stdin } = render(<Controlled initial="ab" />);
  stdin.write("");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("▏"), true);
});

test("does not show the cursor marker when not focused", async () => {
  const { lastFrame } = render(<Controlled initial="ab" focused={false} />);
  assert.equal((lastFrame() ?? "").includes("▏"), false);
});

test("masked mode renders bullets instead of the real characters", async () => {
  const { lastFrame, stdin } = render(<Controlled masked />);
  stdin.write("s");
  await nextTick();
  stdin.write("e");
  await nextTick();
  stdin.write("c");
  await nextTick();
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("sec"), false);
  assert.equal(frame.includes("•••"), true);
});

test("left arrow then typing inserts before the last character, not at the end", async () => {
  const { lastFrame, stdin } = render(<Controlled initial="ac" />);
  stdin.write("\u001B[D"); // left arrow: cursor between a and c
  await nextTick();
  stdin.write("b");
  await nextTick();
  // The cursor marker sits mid-word once the value's middle is the insertion point, so strip it before checking content.
  assert.equal((lastFrame() ?? "").replace("▏", "").includes("abc"), true);
});

test("Home moves the cursor to the start so typing prepends", async () => {
  const { lastFrame, stdin } = render(<Controlled initial="bc" />);
  stdin.write("\u001B[H"); // Home
  await nextTick();
  stdin.write("a");
  await nextTick();
  assert.equal((lastFrame() ?? "").replace("▏", "").includes("abc"), true);
});

test("End moves the cursor back to the end after Home", async () => {
  const { lastFrame, stdin } = render(<Controlled initial="ac" />);
  stdin.write("\u001B[H"); // Home
  await nextTick();
  stdin.write("\u001B[F"); // End
  await nextTick();
  stdin.write("d");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("acd"), true);
});

test("Backspace removes the character before the cursor", async () => {
  const { lastFrame, stdin } = render(<Controlled initial="abc" />);
  stdin.write("\u007F"); // backspace, cursor starts at the end
  await nextTick();
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("ab") && !frame.includes("abc"), true);
});

test("Delete removes the character at the cursor, keeping the cursor in place", async () => {
  const { lastFrame, stdin } = render(<Controlled initial="abc" />);
  stdin.write("\u001B[H"); // Home: cursor before 'a'
  await nextTick();
  stdin.write("\u001B[3~"); // Delete
  await nextTick();
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("bc") && !frame.includes("abc"), true);
});

test("Backspace at the start of the value is a no-op", async () => {
  const { lastFrame, stdin } = render(<Controlled initial="a" />);
  stdin.write("\u001B[H"); // Home
  await nextTick();
  stdin.write("\u007F"); // backspace at position 0
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("a"), true);
});

test("Enter calls onSubmit with the current value", async () => {
  let submitted: string | undefined;
  const { stdin } = render(<Controlled initial="hello" onSubmit={(value) => (submitted = value)} />);
  stdin.write("\r");
  await nextTick();
  assert.equal(submitted, "hello");
});

test("input is ignored entirely when not focused", async () => {
  const { lastFrame, stdin } = render(<Controlled initial="" focused={false} />);
  stdin.write("x");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("x"), false);
});
