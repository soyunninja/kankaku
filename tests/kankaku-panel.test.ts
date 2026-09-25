import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPanelComponent, openKankakuPanel } from "../src/adapters/panel/kankaku-panel.ts";
import type { PanelHost } from "../src/adapters/panel/kankaku-panel.ts";
import { DOWN, ENTER, ESCAPE, fakeTheme, fakeTui, LEFT, UP } from "./helpers/panel-fakes.ts";

/** The panel component always implements `handleInput`/`handleMouse`; narrows past `Component`'s optional signatures for test call sites. */
type TestComponent = Component & {
  handleInput: NonNullable<Component["handleInput"]>;
  handleMouse: NonNullable<Component["handleMouse"]>;
  dispose?(): void;
};

/**
 * A `factory(host) => Component` double that records every input/mouse call
 * it receives. By default it swallows every key, including escape (proving
 * the shell forwards escape instead of handling it itself). Pass
 * `escapeCallsBack: true` to make it behave like a real wired screen (the
 * root `SelectList` and the target screen), whose own `onCancel` calls
 * `host.back()` on escape.
 */
function stubScreen(bodyLine: string, options: { escapeCallsBack?: boolean } = {}) {
  const inputs: string[] = [];
  const mouseEvents: TuiMouseEvent[] = [];
  let capturedHost: PanelHost | undefined;
  const factory = (host: PanelHost): Component => {
    capturedHost = host;
    return {
      render: () => [bodyLine],
      handleInput: (data: string) => {
        inputs.push(data);
        if (options.escapeCallsBack && data === ESCAPE) host.back();
      },
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
  assert.ok(lines[0]!.startsWith("╭─ kankaku"));
  const footer = lines.at(-2)!;
  assert.match(footer, /↑↓ move/);
  assert.match(footer, /enter open/);
  assert.match(footer, /esc close/);
  assert.doesNotMatch(footer, /q close/);
});

test("the panel is drawn inside a rounded frame with one column of inner padding", () => {
  const { ctx, getComponent } = makeCtx();
  void openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  const width = 80;
  const lines = component.render(width);

  // Top border carries the title.
  assert.ok(lines[0]!.startsWith("╭─ kankaku"));
  assert.ok(lines[0]!.endsWith("╮"));

  // Every line, including the borders, is exactly `width` columns wide.
  for (const line of lines) {
    assert.equal(visibleWidth(line), width);
  }

  // Every inner line (everything but the top/bottom border) is padded
  // between the frame's left/right border and one column of padding.
  for (const line of lines.slice(1, -1)) {
    assert.ok(line.startsWith("│ "), `expected "${line}" to start with "│ "`);
    assert.ok(line.endsWith(" │"), `expected "${line}" to end with " │"`);
  }

  // The last line is the bottom border.
  const last = lines.at(-1)!;
  assert.ok(last.startsWith("╰"));
  assert.ok(last.endsWith("╯"));
});

test("the body is rendered at innerWidth = width - 4, not the full frame width", () => {
  const { ctx, getComponent } = makeCtx();
  let capturedWidth: number | undefined;
  const factory = (_host: PanelHost): Component => ({
    render: (w: number) => {
      capturedWidth = w;
      return ["report body"];
    },
    invalidate: () => {},
  });
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(DOWN); // target (no factory) -> report
  component.handleInput(ENTER);
  component.render(80);

  assert.equal(capturedWidth, 76);
});

test("a terminal narrower than 8 columns renders unframed instead of throwing", () => {
  const { ctx, getComponent } = makeCtx();
  void openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  assert.doesNotThrow(() => component.render(6));
  const lines = component.render(6);
  assert.equal(lines[0], "kankaku");
  assert.ok(!lines.some((line) => line.includes("╭") || line.includes("╮") || line.includes("╰") || line.includes("╯")));
});

test("root menu omits hubOnly rows (sync) when the hub is not configured, in order", () => {
  const { ctx, getComponent } = makeCtx();
  const target = stubScreen("target body");
  const report = stubScreen("report body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { target: target.factory, report: report.factory } });
  const component = getComponent()! as TestComponent;

  // Root order with hub not configured: target, report, export, doctor, about
  // (target is not hub-only — only sync is, and it is omitted entirely).
  component.handleInput(DOWN); // target -> report
  component.handleInput(ENTER);
  const lines = component.render(80);
  assert.ok(lines[0]!.startsWith("╭─ kankaku · Report"));
  assert.equal(lines.some((line) => line.includes("report body")), true);
});

test("enter on a root menu item pushes that screen; escape goes back to root (body wires escape to host.back())", () => {
  const { ctx, getComponent } = makeCtx();
  // A real screen (like the root SelectList or the target screen) wires its
  // own onCancel to host.back() — the shell no longer pops on its own.
  const report = stubScreen("report body", { escapeCallsBack: true });
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(DOWN); // target (topmost, no factory registered) -> report
  component.handleInput(ENTER);
  let lines = component.render(80);
  assert.ok(lines[0]!.startsWith("╭─ kankaku · Report"));
  const footer = lines.at(-2)!;
  assert.match(footer, /esc\/← back/);
  assert.match(footer, /q close/);

  component.handleInput(ESCAPE);
  lines = component.render(80);
  assert.ok(lines[0]!.startsWith("╭─ kankaku "));
});

test("escape on a body with handleInput but no capture flag goes back; the shell never forwards it and never relies on the body's onCancel", () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body"); // would swallow escape if it ever reached it
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(DOWN); // target (no factory) -> report
  component.handleInput(ENTER); // push report
  component.handleInput(ESCAPE);

  assert.deepEqual(report.inputs, []); // never forwarded
  // The shell popped the screen itself, not the body's own onCancel wiring.
  assert.ok(component.render(80)[0]!.startsWith("╭─ kankaku "));
});

test("escape is forwarded to the body while PanelHost.setBodyCapturesEscape(true) is set, and does not navigate", () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(DOWN); // target (no factory) -> report
  component.handleInput(ENTER); // push report
  const host = report.getHost()!;
  host.setBodyCapturesEscape(true);

  component.handleInput(ESCAPE);
  assert.deepEqual(report.inputs, [ESCAPE]);
  // Still on "Report": the body captured escape, so the shell did not navigate.
  assert.ok(component.render(80)[0]!.startsWith("╭─ kankaku · Report"));
});

test("left arrow on a screen with no capture flag goes back, like escape", () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(DOWN); // target (no factory) -> report
  component.handleInput(ENTER); // push report
  component.handleInput(LEFT);

  assert.deepEqual(report.inputs, []);
  assert.ok(component.render(80)[0]!.startsWith("╭─ kankaku "));
});

test("left arrow at root closes the panel, like escape", async () => {
  const { ctx, getComponent } = makeCtx();
  const donePromise = openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  component.handleInput(LEFT);
  await donePromise;
});

test("left arrow with the capture flag set forwards the escape sequence to the body", () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(DOWN); // target (no factory) -> report
  component.handleInput(ENTER); // push report
  const host = report.getHost()!;
  host.setBodyCapturesEscape(true);

  component.handleInput(LEFT);
  assert.deepEqual(report.inputs, [ESCAPE]); // translated to the escape sequence
  assert.ok(component.render(80)[0]!.startsWith("╭─ kankaku · Report"));
});

test("escape on a placeholder body with no handleInput (e.g. 'coming soon') pops the screen itself", () => {
  const { ctx, getComponent } = makeCtx();
  void openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  component.handleInput(ENTER); // first root item (target) has no factory registered -> "coming soon"
  assert.ok(component.render(80).some((line) => line.includes("coming soon")));

  component.handleInput(ESCAPE);
  assert.ok(component.render(80)[0]!.startsWith("╭─ kankaku "));
});

test("a screen with no registered factory renders a 'coming soon' placeholder", () => {
  const { ctx, getComponent } = makeCtx();
  void openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  component.handleInput(ENTER); // first root item (target) has no factory registered
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

  component.handleInput(DOWN); // target (no factory) -> report
  component.handleInput(ENTER); // push report; body is now the stub
  component.handleInput("x");
  assert.deepEqual(report.inputs, ["x"]);
});

test("a click on the footer's 'esc' hint span closes the panel (coordinates include the frame's left border and padding)", async () => {
  const { ctx, getComponent } = makeCtx();
  const donePromise = openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  const lines = component.render(80);
  // The last line is the bottom border; the footer hints line is just above it.
  const footerRow = lines.length - 2;
  const footerLine = lines[footerRow]!;
  const x = footerLine.indexOf("esc");
  assert.ok(x >= 0, "the footer must render an 'esc' hint");
  assert.ok(x >= 2, "the hint's column must already include the frame's left border + padding");

  component.handleMouse(clickEvent(x, footerRow));
  await donePromise;
});

test("hovering the footer's 'esc' hint highlights it on the next render", () => {
  const { ctx, getComponent } = makeCtx();
  void openKankakuPanel(ctx, { hubConfigured: false, screens: {} });
  const component = getComponent()! as TestComponent;

  const lines = component.render(80);
  const footerRow = lines.length - 2;
  const x = lines[footerRow]!.indexOf("esc");

  component.handleMouse(moveEvent(x, footerRow));
  const after = component.render(80);
  assert.match(after[footerRow]!, /\[esc close\]/);
});

test("a mouse click on a body row is delegated to the body with frame-shifted coordinates", () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(DOWN); // target (no factory) -> report
  component.handleInput(ENTER); // push report; body is now the stub
  const lines = component.render(80);
  const bodyRow = lines.findIndex((line) => line.includes("report body"));
  assert.ok(bodyRow >= 0, "the body row must be found in the rendered frame");

  component.handleMouse(clickEvent(5, bodyRow));
  assert.equal(report.mouseEvents.length, 1);
  const event = report.mouseEvents[0]!;
  // Top border (1) + blank inner line (1) = 2 rows above the body; left
  // border "│" + one padding space = 2 columns to its left.
  assert.equal(event.y, bodyRow - 2);
  assert.equal(event.x, 5 - 2);
  assert.equal(event.width, 76); // innerWidth = width(80) - 4
});

test("a mouse click outside the body rows (the frame border or blank padding) is not delegated", () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(DOWN); // target (no factory) -> report
  component.handleInput(ENTER); // push report; body is now the stub
  component.render(80);
  component.handleMouse(clickEvent(0, 0)); // top border row, not the body
  assert.equal(report.mouseEvents.length, 0);
});

test("PanelHost.push/back/close let a registered screen navigate the panel itself", async () => {
  const { ctx, getComponent } = makeCtx();
  const target = stubScreen("target body");
  const donePromise = openKankakuPanel(ctx, { hubConfigured: true, screens: { target: target.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(ENTER); // hubConfigured:true -> first root item is "target"
  const host = target.getHost()!;
  assert.ok(component.render(80)[0]!.startsWith("╭─ kankaku · Target"));

  host.close();
  await donePromise;
});

test("down arrow moves the root selection before enter opens it", () => {
  const { ctx, getComponent } = makeCtx();
  const report = stubScreen("report body");
  const doctor = stubScreen("doctor body");
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: report.factory, doctor: doctor.factory } });
  const component = getComponent()! as TestComponent;

  // hubConfigured:false root order is: target, report, export, doctor, about.
  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(ENTER);
  const lines = component.render(80);
  assert.ok(lines[0]!.startsWith("╭─ kankaku · Doctor"));

  component.handleInput(UP); // no-op: doctor's stub body ignores unrecognised input, proving it was forwarded, not swallowed
  assert.deepEqual(doctor.inputs, [UP]);
});

test("PanelHost.setBodyWantsText(true) makes 'q' forward to the body instead of closing", async () => {
  const { ctx, getComponent } = makeCtx();
  const target = stubScreen("target body");
  const donePromise = openKankakuPanel(ctx, { hubConfigured: true, screens: { target: target.factory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(ENTER); // hubConfigured:true -> first root item is "target"
  const host = target.getHost()!;

  host.setBodyWantsText(true);
  component.handleInput("q");
  assert.deepEqual(target.inputs, ["q"]);

  host.setBodyWantsText(false);
  component.handleInput("q");
  await donePromise;
});

test("footer shows the search hint when the current body is searchable", () => {
  const { ctx, getComponent } = makeCtx();
  const searchableFactory = (_host: PanelHost): Component & { searchable?: boolean } => ({
    render: () => ["report body"],
    invalidate: () => {},
    searchable: true,
  });
  void openKankakuPanel(ctx, { hubConfigured: false, screens: { report: searchableFactory } });
  const component = getComponent()! as TestComponent;

  component.handleInput(DOWN); // target (no factory) -> report
  component.handleInput(ENTER);
  const footer = component.render(80).at(-2)!;
  assert.match(footer, /\/ search/);
});

test("createPanelComponent renders standalone, without going through openKankakuPanel", () => {
  const tui = fakeTui();
  const theme = fakeTheme();
  let doneResult: void | "pending" = "pending";
  const component = createPanelComponent(tui, theme, { hubConfigured: false, screens: {} }, (result) => {
    doneResult = result;
  }) as TestComponent;

  const lines = component.render(80);
  assert.ok(lines[0]!.startsWith("╭─ kankaku "));

  component.handleInput(ESCAPE);
  assert.equal(doneResult, undefined);
});
