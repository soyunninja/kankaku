import assert from "node:assert/strict";
import { test } from "node:test";
import type { SettingsListTheme } from "@earendil-works/pi-tui";
import { actionItem } from "../src/adapters/panel/panel-items.ts";

/** `hint` is wrapped distinctively so the pending indicator is unambiguous in assertions; everything else passes through. */
function fakeTheme(): SettingsListTheme {
  return {
    label: (text) => text,
    value: (text) => text,
    description: (text) => text,
    cursor: "> ",
    hint: (text) => `hint(${text})`,
  };
}

/** Flush every currently-queued microtask (an `await`ed `run()` settles on one). */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("actionItem builds a SettingItem from id/label/description, with no value-cycling", () => {
  const item = actionItem(fakeTheme(), {
    id: "remember",
    label: "Remember",
    description: "stores clientId/projectId",
    run: () => [],
  });

  assert.equal(item.id, "remember");
  assert.equal(item.label, "Remember");
  assert.equal(item.description, "stores clientId/projectId");
  assert.equal(item.values, undefined);
  assert.equal(typeof item.submenu, "function");
});

test("actionItem omits description when none is given", () => {
  const item = actionItem(fakeTheme(), { id: "remember", label: "Remember", run: () => [] });
  assert.equal(item.description, undefined);
});

test("the submenu shows a pending '…' line before run() settles", () => {
  const run = () => new Promise<string[]>(() => {}); // never settles
  const item = actionItem(fakeTheme(), { id: "remember", label: "Remember", run });
  const component = item.submenu!("", () => {});

  assert.deepEqual(component.render(80), ["hint(…)"]);
});

test("the submenu shows run()'s lines once it resolves, and calls onDone", async () => {
  let onDoneCalls = 0;
  const item = actionItem(fakeTheme(), {
    id: "remember",
    label: "Remember",
    run: async () => ["saved clientId/projectId to config.json"],
    onDone: () => {
      onDoneCalls++;
    },
  });
  const component = item.submenu!("", () => {});

  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(component.render(80), ["saved clientId/projectId to config.json"]);
  assert.equal(onDoneCalls, 1);
});

test("a synchronous run() (a plain array, not a promise) also settles and renders its lines", async () => {
  const item = actionItem(fakeTheme(), { id: "remember", label: "Remember", run: () => ["nothing to save"] });
  const component = item.submenu!("", () => {});

  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(component.render(80), ["nothing to save"]);
});

test("an error thrown by run() renders as 'error: <message>' and still calls onDone", async () => {
  let onDoneCalls = 0;
  const item = actionItem(fakeTheme(), {
    id: "remember",
    label: "Remember",
    run: async () => {
      throw new Error("disk full");
    },
    onDone: () => {
      onDoneCalls++;
    },
  });
  const component = item.submenu!("", () => {});

  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(component.render(80), ["error: disk full"]);
  assert.equal(onDoneCalls, 1);
});

test("a non-Error throw from run() is stringified into the error line", async () => {
  const item = actionItem(fakeTheme(), {
    id: "remember",
    label: "Remember",
    run: async () => {
      throw "boom";
    },
  });
  const component = item.submenu!("", () => {});

  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(component.render(80), ["error: boom"]);
});

test("Enter closes the submenu, keeping the cursor on this row via navigateTo", () => {
  const calls: Array<[string | undefined, { navigateTo?: string } | undefined]> = [];
  const item = actionItem(fakeTheme(), { id: "remember", label: "Remember", run: () => [] });
  const component = item.submenu!("", (selectedValue, options) => calls.push([selectedValue, options]));

  component.handleInput!("\r");

  assert.deepEqual(calls, [[undefined, { navigateTo: "remember" }]]);
});

test("Escape also closes the submenu, keeping the cursor on this row via navigateTo", () => {
  const calls: Array<[string | undefined, { navigateTo?: string } | undefined]> = [];
  const item = actionItem(fakeTheme(), { id: "remember", label: "Remember", run: () => [] });
  const component = item.submenu!("", (selectedValue, options) => calls.push([selectedValue, options]));

  component.handleInput!("\x1b");

  assert.deepEqual(calls, [[undefined, { navigateTo: "remember" }]]);
});

test("a key other than Enter/Escape does not close the submenu", () => {
  const calls: unknown[] = [];
  const item = actionItem(fakeTheme(), { id: "remember", label: "Remember", run: () => [] });
  const component = item.submenu!("", (...args) => calls.push(args));

  component.handleInput!("x");

  assert.equal(calls.length, 0);
});
