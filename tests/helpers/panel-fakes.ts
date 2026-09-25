/**
 * Shared test doubles for the `/kankaku` panel adapter tests
 * (`kankaku-panel.test.ts`, `panel-target.test.ts`, and future per-screen
 * test files): the key strings every test drives `handleInput` with, a
 * fake pi `Theme`, a fake pi-tui `TUI`, and a fake `PanelHost` for driving
 * a screen factory directly, without going through `openKankakuPanel`.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { PanelHost } from "../../src/adapters/panel/kankaku-panel.ts";
import type { PanelScreenId } from "../../src/domain/panel-model.ts";

export const UP = "\x1b[A";
export const DOWN = "\x1b[B";
export const LEFT = "\x1b[D";
export const ENTER = "\r";
export const ESCAPE = "\x1b";

/** `fg`/`bold` pass text through unchanged; `inverse` wraps it so hover/selection state is observable in rendered output. */
export function fakeTheme(): Theme {
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

export function fakeTui(): TUI & { renderRequests: number } {
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

/** A `PanelHost` double for driving a screen factory (`PanelScreenFactory`) directly, without mounting the whole panel shell. */
export interface FakeHost extends PanelHost {
  pushed: PanelScreenId[];
  backCalls: number;
  closeCalls: number;
  renderRequests: number;
  bodyWantsText: boolean;
  bodyCapturesEscape: boolean;
}

export function fakeHost(overrides: Partial<Pick<PanelHost, "theme" | "tui">> = {}): FakeHost {
  const host: FakeHost = {
    tui: overrides.tui ?? fakeTui(),
    theme: overrides.theme ?? fakeTheme(),
    pushed: [],
    backCalls: 0,
    closeCalls: 0,
    renderRequests: 0,
    bodyWantsText: false,
    bodyCapturesEscape: false,
    push: (id) => host.pushed.push(id),
    back: () => {
      host.backCalls++;
    },
    close: () => {
      host.closeCalls++;
    },
    requestRender: () => {
      host.renderRequests++;
    },
    setBodyWantsText: (flag) => {
      host.bodyWantsText = flag;
    },
    setBodyCapturesEscape: (flag) => {
      host.bodyCapturesEscape = flag;
    },
  };
  return host;
}
