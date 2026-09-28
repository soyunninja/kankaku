import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsList } from "@earendil-works/pi-tui";
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

test("Enter closes the result inside a real SettingsList without reopening it or re-running the action", () => {
  let runs = 0;
  const item = actionItem(fakeTheme(), { id: "sync-now", label: "Sync now", run: () => { runs += 1; return ["done"]; } });
  const list = new SettingsList([{ id: "status", label: "Status", currentValue: "ok" }, item], 10, fakeTheme(), () => {}, () => {}, { enableSearch: false });

  list.handleInput("\x1b[B");
  list.handleInput("\r");
  assert.equal(runs, 1);
  assert.match(list.render(60).join("\n"), /hint\(…\)|done/);

  list.handleInput("\r");

  assert.equal(runs, 1, "closing the result must not run the action again");
  assert.match(list.render(60).join("\n"), /Sync now/, "the list is visible again, not the result");
  assert.equal(list.render(60).some((line) => line.includes("> ") && line.includes("Sync now")), true, "the cursor stays on the action row");
});

test("Escape also closes the result inside a real SettingsList without reopening it", () => {
  let runs = 0;
  const item = actionItem(fakeTheme(), { id: "sync-now", label: "Sync now", run: () => { runs += 1; return ["done"]; } });
  const list = new SettingsList([{ id: "status", label: "Status", currentValue: "ok" }, item], 10, fakeTheme(), () => {}, () => {}, { enableSearch: false });

  list.handleInput("\x1b[B");
  list.handleInput("\r");
  list.handleInput("\x1b");

  assert.equal(runs, 1);
  assert.match(list.render(60).join("\n"), /Sync now/);
});

test("onOpen fires when the submenu component is created", () => {
  let onOpenCalls = 0;
  const item = actionItem(fakeTheme(), {
    id: "remember",
    label: "Remember",
    run: () => [],
    onOpen: () => {
      onOpenCalls++;
    },
  });

  assert.equal(onOpenCalls, 0);
  item.submenu!("", () => {});
  assert.equal(onOpenCalls, 1);
});

test("onClose fires right before done(...) on Enter", () => {
  const calls: string[] = [];
  const item = actionItem(fakeTheme(), {
    id: "remember",
    label: "Remember",
    run: () => [],
    onClose: () => calls.push("close"),
  });
  const component = item.submenu!("", () => calls.push("done"));

  component.handleInput!("\r");

  assert.deepEqual(calls, ["close", "done"]);
});

test("onClose fires right before done(...) on Escape", () => {
  const calls: string[] = [];
  const item = actionItem(fakeTheme(), {
    id: "remember",
    label: "Remember",
    run: () => [],
    onClose: () => calls.push("close"),
  });
  const component = item.submenu!("", () => calls.push("done"));

  component.handleInput!("\x1b");

  assert.deepEqual(calls, ["close", "done"]);
});

test("a key other than Enter/Escape does not close the submenu", () => {
  const calls: unknown[] = [];
  const item = actionItem(fakeTheme(), { id: "remember", label: "Remember", run: () => [] });
  const component = item.submenu!("", (...args) => calls.push(args));

  component.handleInput!("x");

  assert.equal(calls.length, 0);
});
