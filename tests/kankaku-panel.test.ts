import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { createPanelComponent, openKankakuPanel } from "../src/adapters/panel/kankaku-panel.ts";
import type { PanelHost } from "../src/adapters/panel/kankaku-panel.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";

/** The panel component always implements `handleInput`/`handleMouse`; narrows past `Component`'s optional signatures for test call sites. */
type TestComponent = Component & {
  handleInput: NonNullable<Component["handleInput"]>;
  handleMouse: NonNullable<Component["handleMouse"]>;
  dispose?(): void;
};

/** `fg`/`bold` pass text through unchanged; `inverse` wraps it so hover state is observable in rendered output. */
function fakeTheme(): Theme {
  return {
    fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => `[${text}]`,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

function fakeTui(): TUI & { renderRequests: number } {
  const tui = {
    renderRequests: 0,
    requestRender() {
      tui.renderRequests++;
    },
    setFocus: () => {},
    terminal: { columns: 100, rows: 40 },
  };
  return tui as unknown as TUI & { renderRequests: number };
}

/** A `factory(host) => Component` double that records every input/mouse call it receives. */
function stubScreen(bodyLine: string) {
  const inputs: string[] = [];
  const mouseEvents: TuiMouseEvent[] = [];
  let capturedHost: PanelHost | undefined;
  const factory = (host: PanelHost): Component => {
    capturedHost = host;
    return {
      render: () => [bodyLine],
      handleInput: (data: string) => inputs.push(data),
      handleMouse: (event: TuiMouseEvent): TuiMouseEventResult => {
        mouseEvents.push(event);
        return { handled: true };
      },
      invalidate: () => {},
    };
  };
  return { factory, inputs, mouseEvents, getHost: () => capturedHost };
}

function clickEvent(x: number, y: number): TuiMouseEvent {
  return { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 80, height: 40, shift: false, alt: false, ctrl: false, clickCount: 1 };
}

function moveEvent(x: number, y: number): TuiMouseEvent {
  return { type: "move", button: "none", x, y, screenX: x, screenY: y, width: 80, height: 40, shift: false, alt: false, ctrl: false };
}

function makeCtx(overrides: Record<string, unknown> = {}): { ctx: ExtensionContext; customCalls: Array<{ options: unknown }>; getComponent: () => (Component & { dispose?(): void }) | undefined; getDone: () => ((result: void) => void) | undefined } {
  let component: (Component & { dispose?(): void }) | undefined;
  let done: ((result: void) => void) | undefined;
  const customCalls: Array<{ options: unknown }> = [];

  const custom = async (
    factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: void) => void) => Component & { dispose?(): void },
    options: unknown,
  ) => {
    customCalls.push({ options });
    return new Promise<void>((resolve) => {
      done = resolve;
      component = factory(fakeTui(), fakeTheme(), undefined, resolve);
    });
  };

  const ctx = {
    hasUI: true,
    ui: { custom, notify: () => {} },
    ...overrides,
  } as unknown as ExtensionContext;

  return { ctx, customCalls, getComponent: () => component, getDone: () => done };
}

test("openKankakuPanel is a no-op without a UI", async () => {
  const { ctx, customCalls } = makeCtx({ hasUI: false });
  await openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  assert.equal(customCalls.length, 0);
});

test("openKankakuPanel opens the overlay with the panel's fixed positioning", () => {
  const { ctx, customCalls } = makeCtx();
  void openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  assert.equal(customCalls.length, 1);
  assert.deepEqual(customCalls[0]!.options, {
    overlay: true,
    overlayOptions: { width: "80%", minWidth: 64, maxHeight: "80%", anchor: "center" },
  });
});

test("root renders the panel title and root footer hints (esc close, no q)", () => {
  const { ctx, getComponent } = makeCtx();
  void openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  const lines = component.render(80);
  assert.equal(lines[0], "kankaku");
  const footer = lines.at(-1)!;
  assert.match(footer, /↑↓ move/);
  assert.match(footer, /enter open/);
  assert.match(footer, /esc close/);
  assert.doesNotMatch(footer, /q close/);
});

test("root menu omits hubOnly rows when the hub is not configured, in order", () => {
  const { ctx, getComponent } = makeCtx();
  const target = stubScreen("target body");
  const report = stubScreen("report body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { target: target.factory, report: report.factory } });
  const component = getComponent()! as TestComponent;

  // First menu row (index 0) must be "report" (target is hubOnly and hub is not configured).
  component.handleInput(ENTER);
  const lines = component.render(80);
  assert.equal(lines[0], "kankaku · Report");
  assert.equal(lines.some((line) => line === "report body"), true);
});

test("enter on a root menu item pushes that screen; escape goes back to root", () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(ENTER); // selects the first (and, with hubConfigured:false, topmost) item: report
  let lines = component.render(80);
  assert.equal(lines[0], "kankaku · Report");
  const footer = lines.at(-1)!;
  assert.match(footer, /esc back/);
  assert.match(footer, /q close/);

  component.handleInput(ESCAPE);
  lines = component.render(80);
  assert.equal(lines[0], "kankaku");
});

test("a screen with no registered factory renders a 'coming soon' placeholder", () => {
  const { ctx, getComponent } = makeCtx();
  void openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  component.handleInput(ENTER); // first root item (report) has no factory registered
  const lines = component.render(80);
  assert.ok(lines.some((line) => line.includes("coming soon")));
});

test("escape at root closes the panel (done fires)", async () => {
  const { ctx, getComponent } = makeCtx();
  const donePromise = openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  component.handleInput(ESCAPE);
  await donePromise;
});

test("'q' closes the panel from a pushed screen", async () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body");
  const donePromise = openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(ENTER); // push report
  component.handleInput("q");
  await donePromise;
});

test("keys other than escape/q/arrows/enter are forwarded to the body", () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(ENTER); // push report; body is now the stub
  component.handleInput("x");
  assert.deepEqual(report.inputs, ["x"]);
});

test("a click on the footer's 'esc' hint span closes the panel", async () => {
  const { ctx, getComponent } = makeCtx();
  const donePromise = openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  const lines = component.render(80);
  const footerRow = lines.length - 1;
  const footerLine = lines[footerRow]!;
  const x = footerLine.indexOf("esc");
  assert.ok(x >= 0, "the footer must render an 'esc' hint");

  component.handleMouse(clickEvent(x, footerRow));
  await donePromise;
});

test("hovering the footer's 'esc' hint highlights it on the next render", () => {
  const { ctx, getComponent } = makeCtx();
  void openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  const lines = component.render(80);
  const footerRow = lines.length - 1;
  const x = lines[footerRow]!.indexOf("esc");

  component.handleMouse(moveEvent(x, footerRow));
  const after = component.render(80);
  assert.match(after[footerRow]!, /\[esc close\]/);
});

test("a mouse event outside the footer row is delegated to the body", () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(ENTER); // push report; body is now the stub
  component.handleMouse(clickEvent(0, 0)); // title row, never the footer
  assert.equal(report.mouseEvents.length, 1);
});

test("PanelHost.push/back/close let a registered screen navigate the panel itself", async () => {
  const { ctx, getComponent } = makeCtx();
  const target = stubScreen("target body");
  const donePromise = openKankakuPanel(ctx, { hubConfigured: true, screens: { target: target.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(ENTER); // hubConfigured:true -> first root item is "target"
  const host = target.getHost()!;
  assert.equal(component.render(80)[0], "kankaku · Target");

  host.close();
  await donePromise;
});

test("down arrow moves the root selection before enter opens it", () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body");
  const doctor = stubScreen("doctor body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory, doctor: doctor.factory } });
  const component = getComponent()! as TestComponent;

  // hubConfigured:false root order is: report, export, doctor, about.
  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(ENTER);
  const lines = component.render(80);
  assert.equal(lines[0], "kankaku · Doctor");

  component.handleInput(UP); // no-op: doctor's stub body ignores unrecognised input, proving it was forwarded, not swallowed
  assert.deepEqual(doctor.inputs, [UP]);
});

test("createPanelComponent renders standalone, without going through openKankakuPanel", () => {
  const tui = fakeTui();
  const theme = fakeTheme();
  let doneResult: void | "pending" = "pending";
  const component = createPanelComponent(tui, theme, { hubConfigured: false, screens: {} }, (result) => {
    doneResult = result;
  }) as TestComponent;

  const lines = component.render(80);
  assert.equal(lines[0], "kankaku");

  component.handleInput(ESCAPE);
  assert.equal(doneResult, undefined);
});
