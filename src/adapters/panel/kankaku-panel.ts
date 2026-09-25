/**
 * The `/kankaku` overlay panel shell (see odd/tasks/kankaku-panel.md):
 * title row, current screen body, and a footer hint row that is both a
 * keyboard legend and (in fullscreen, where mouse events are dispatched —
 * see the "Verified facts" section of the feature doc) clickable.
 *
 * Screens (`screens/root.ts` for P1; `screens/target.ts` etc. in later
 * tasks) are supplied by the caller through {@link KankakuPanelDeps}; a
 * screen id with no registered factory renders a "coming soon" placeholder
 * so navigation stays testable before every screen exists.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Key, matchesKey, SelectList, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { SelectItem } from "@earendil-works/pi-tui";
import { footerHints, navBack, navCurrent, navPush, navRoot, panelTitle, rootMenu } from "../../domain/panel-model.ts";
import type { PanelHint, PanelNav, PanelScreenId } from "../../domain/panel-model.ts";
import { buildSelectListTheme } from "./panel-theme.ts";

/** A screen's component factory, given a {@link PanelHost} so it can navigate the panel or trigger a re-render. */
export type PanelScreenFactory = (host: PanelHost) => Component & { dispose?(): void; searchable?: boolean };

/** What a screen factory can do to the panel that hosts it. */
export interface PanelHost {
  tui: TUI;
  theme: Theme;
  push(id: PanelScreenId): void;
  back(): void;
  close(): void;
  requestRender(): void;
  /**
   * Set (or clear) whether the current body owns a text field (e.g. the
   * target screen's legacy-label `Input`). While `true`, `q` is forwarded
   * to the body like any other key instead of closing the panel — so
   * typing the letter `q` into a text field never closes the overlay. A
   * screen must reset this to `false` when its text field closes (see
   * `screens/target.ts`'s legacy-label submenu).
   */
  setBodyWantsText(flag: boolean): void;
}

export interface KankakuPanelDeps {
  hubConfigured: boolean;
  screens: Partial<Record<Exclude<PanelScreenId, "root">, PanelScreenFactory>>;
}

type PanelBody = Component & { dispose?(): void; searchable?: boolean };

interface HintSpan {
  start: number;
  end: number;
}

const HINT_SEPARATOR = " · ";

/** Placeholder body for a screen id with no registered factory yet (P2–P4 fill these in). */
function comingSoonBody(theme: Theme): PanelBody {
  return new Text(theme.fg("muted", "coming soon"));
}

/** Builds one root-menu row per {@link rootMenu} item. */
function buildRootItems(hubConfigured: boolean): SelectItem[] {
  return rootMenu({ hubConfigured }).map((item) => ({
    value: item.id,
    label: item.label,
    description: item.description,
  }));
}

/**
 * Render the footer hint line and, alongside it, the clickable column range
 * of each hint (in local, cell-based coordinates — see
 * `TuiMouseEvent.x`), so `handleMouse` can hit-test a click without
 * re-deriving the layout from ANSI-colored text.
 */
function renderFooter(hints: PanelHint[], theme: Theme, hoveredIndex: number | undefined): { line: string; spans: HintSpan[] } {
  let column = 0;
  let line = "";
  const spans: HintSpan[] = [];

  hints.forEach((hint, index) => {
    if (index > 0) {
      line += theme.fg("muted", HINT_SEPARATOR);
      column += visibleWidth(HINT_SEPARATOR);
    }
    const text = `${hint.key} ${hint.label}`;
    const start = column;
    line += index === hoveredIndex ? theme.inverse(text) : `${theme.fg("accent", hint.key)} ${theme.fg("muted", hint.label)}`;
    column += visibleWidth(text);
    spans.push({ start, end: column });
  });

  return { line, spans };
}

class KankakuPanelComponent implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly deps: KankakuPanelDeps;
  private readonly done: (result: void) => void;
  private readonly host: PanelHost;

  private nav: PanelNav;
  private body: PanelBody;
  /** Set via `PanelHost.setBodyWantsText` by a screen that owns a text field (e.g. the target screen's legacy-label `Input`), so `q` types instead of closing. */
  private bodyWantsText = false;
  private hints: PanelHint[] = [];
  private hintSpans: HintSpan[] = [];
  /** -1 until the first `render()`, so a mouse event that arrives before any render never mismatches row 0 for the footer. */
  private footerRowIndex = -1;
  private hoveredHintIndex: number | undefined;

  constructor(tui: TUI, theme: Theme, deps: KankakuPanelDeps, done: (result: void) => void) {
    this.tui = tui;
    this.theme = theme;
    this.deps = deps;
    this.done = done;
    this.host = {
      tui,
      theme,
      push: (id) => this.pushScreen(id),
      back: () => this.goBack(),
      close: () => this.closePanel(),
      requestRender: () => this.tui.requestRender(),
      setBodyWantsText: (flag) => {
        this.bodyWantsText = flag;
      },
    };
    this.nav = navRoot();
    this.body = this.createBody("root");
  }

  private createBody(id: PanelScreenId): PanelBody {
    if (id === "root") {
      const list = new SelectList(buildRootItems(this.deps.hubConfigured), 10, buildSelectListTheme(this.theme));
      list.onSelect = (item) => this.pushScreen(item.value as PanelScreenId);
      list.onCancel = () => this.goBack();
      return list;
    }

    const factory = this.deps.screens[id];
    return factory ? factory(this.host) : comingSoonBody(this.theme);
  }

  private pushScreen(id: PanelScreenId): void {
    this.body.dispose?.();
    this.nav = navPush(this.nav, id);
    this.body = this.createBody(id);
    this.bodyWantsText = false;
    this.hoveredHintIndex = undefined;
    this.tui.requestRender();
  }

  private goBack(): void {
    const { nav, closed } = navBack(this.nav);
    if (closed) {
      this.closePanel();
      return;
    }
    this.body.dispose?.();
    this.nav = nav;
    this.body = this.createBody(navCurrent(nav));
    this.bodyWantsText = false;
    this.hoveredHintIndex = undefined;
    this.tui.requestRender();
  }

  private closePanel(): void {
    this.body.dispose?.();
    this.done(undefined);
  }

  invalidate(): void {
    this.body.invalidate();
  }

  dispose(): void {
    this.body.dispose?.();
  }

  render(width: number): string[] {
    const screen = navCurrent(this.nav);
    const lines: string[] = [];
    lines.push(this.theme.bold(this.theme.fg("accent", panelTitle(screen))));
    lines.push("");
    lines.push(...this.body.render(width));
    lines.push("");

    this.hints = footerHints(screen, { searchable: this.body.searchable ?? false });
    const { line, spans } = renderFooter(this.hints, this.theme, this.hoveredHintIndex);
    this.hintSpans = spans;
    this.footerRowIndex = lines.length;
    lines.push(line);

    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      // Forward escape to the body when it can handle input itself (a real
      // `SettingsList`/`SelectList`-backed screen): pi-tui's own
      // `SettingsList.handleInput`/`SelectList.handleInput` already close an
      // open submenu on escape and fall through to the body's own
      // `onCancel` only once no submenu remains — wired to `host.back()` by
      // every real screen (the root `SelectList`, the target screen). Only
      // a body with no `handleInput` at all (the placeholder "coming soon"
      // `Text`, or a read-only note like the subagent target screen) has no
      // way to react, so the shell pops the stack itself in that case.
      if (this.body.handleInput) {
        this.body.handleInput(data);
      } else {
        this.goBack();
      }
      return;
    }
    if (data === "q" && !this.bodyWantsText) {
      this.closePanel();
      return;
    }
    this.body.handleInput?.(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y === this.footerRowIndex) {
      return this.handleFooterMouse(event);
    }
    return this.body.handleMouse?.(event);
  }

  private handleFooterMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const hitIndex = this.hintSpans.findIndex((span) => event.x >= span.start && event.x < span.end);

    if (event.type === "move") {
      if (hitIndex !== this.hoveredHintIndex) {
        this.hoveredHintIndex = hitIndex === -1 ? undefined : hitIndex;
        return { handled: true, render: true };
      }
      return { handled: true, render: false };
    }

    if (event.type === "click" && event.button === "left" && hitIndex !== -1) {
      const hint = this.hints[hitIndex]!;
      if (hint.key === "esc") {
        this.goBack();
        return { handled: true };
      }
      if (hint.key === "q") {
        this.closePanel();
        return { handled: true };
      }
    }

    return { handled: true, render: false };
  }
}

/** Builds the panel shell component; see {@link openKankakuPanel} for how it is mounted. */
export function createPanelComponent(tui: TUI, theme: Theme, deps: KankakuPanelDeps, done: (result: void) => void): Component & { dispose?(): void } {
  return new KankakuPanelComponent(tui, theme, deps, done);
}

/**
 * Opens the `/kankaku` panel as a focused overlay. A no-op when no UI is
 * attached (print/RPC mode) — the caller (`kankaku-command.ts`) falls back
 * to the existing report notification in that case.
 */
export async function openKankakuPanel(ctx: ExtensionContext, deps: KankakuPanelDeps): Promise<void> {
  if (!ctx.hasUI) return;
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => createPanelComponent(tui, theme, deps, done), {
    overlay: true,
    overlayOptions: { width: "80%", minWidth: 64, maxHeight: "80%", anchor: "center" },
  });
}
