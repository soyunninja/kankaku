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
import { Key, matchesKey, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
  /**
   * Set (or clear) whether the current body owns Escape (a submenu or text
   * field is open and must see it before the shell does — e.g. the target
   * screen's client/project/task submenus, its legacy-label `Input`, or an
   * `actionItem`'s result view). The shell owns Escape (and left arrow) by
   * default and pops the current screen itself: it never relies on
   * pi-tui's `SettingsList`/`SelectList` `onCancel` firing on its own,
   * since that path does not reliably fire in the real TUI (see
   * `KankakuPanelComponent#handleInput`). A screen must reset this to
   * `false` when the thing that captured Escape closes (see
   * `screens/target.ts` and every `actionItem` call site).
   */
  setBodyCapturesEscape(flag: boolean): void;
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

/**
 * Below this width the frame (border + one column of inner padding) no
 * longer leaves room for any content, so `render` falls back to the
 * unframed layout instead of throwing (see `KankakuPanelComponent#render`).
 */
const MIN_FRAME_WIDTH = 8;

/** Columns the frame's left border ("│") and its one column of padding occupy, left of every inner/body row. */
const FRAME_LEFT_PADDING = 2;

/**
 * Wraps `content` between the frame's left/right border (`│ ... │`),
 * padding/truncating it to `innerWidth` first — ANSI-safe, via pi-tui's
 * `truncateToWidth` (never raw string length; see the module doc).
 */
function frameLine(theme: Theme, content: string, innerWidth: number): string {
  const left = theme.fg("border", "│ ");
  const right = theme.fg("border", " │");
  const padded = truncateToWidth(content, innerWidth, "…", true);
  return `${left}${padded}${right}`;
}

/**
 * The framed top border: `╭─ <title> ` then a `─` fill, then `╮`, sized to
 * `width`. `titleStyled` keeps its own styling (bold/accent, applied by the
 * caller); it is itself truncated (ANSI-aware) if the title cannot fit.
 */
function frameTop(theme: Theme, titleStyled: string, width: number): string {
  const available = Math.max(0, width - 5); // "╭─ " + " " + "╮"
  const title = truncateToWidth(titleStyled, available, "…", false);
  const fillLen = Math.max(0, available - visibleWidth(title));
  const left = theme.fg("border", "╭─ ");
  const fill = theme.fg("border", `${"─".repeat(fillLen)}╮`);
  return `${left}${title} ${fill}`;
}

/** The framed bottom border: `╰` + a `─` fill + `╯`, sized to `width`. */
function frameBottom(theme: Theme, width: number): string {
  return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

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
  /** Set via `PanelHost.setBodyCapturesEscape` by a screen whose body must see Escape/← itself (an open submenu or text field) before the shell pops the screen. */
  private bodyCapturesEscape = false;
  private hints: PanelHint[] = [];
  private hintSpans: HintSpan[] = [];
  /** -1 until the first `render()`, so a mouse event that arrives before any render never mismatches row 0 for the footer. */
  private footerRowIndex = -1;
  private hoveredHintIndex: number | undefined;
  /** Whether the last `render()` drew the frame (`width >= MIN_FRAME_WIDTH`) or fell back to the unframed layout. */
  private framed = false;
  /** -1 until the first `render()` draws the frame; the absolute row index of the body's first rendered line. */
  private bodyRowStart = -1;
  private bodyRowCount = 0;
  /** The width last passed to `this.body.render(...)` (`width` unframed, `width - 4` framed), for shifted mouse events. */
  private bodyWidth = 0;

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
      setBodyCapturesEscape: (flag) => {
        this.bodyCapturesEscape = flag;
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
    this.bodyCapturesEscape = false;
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
    this.bodyCapturesEscape = false;
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
    const titleStyled = this.theme.bold(this.theme.fg("accent", panelTitle(screen)));
    this.hints = footerHints(screen, { searchable: this.body.searchable ?? false });

    if (width < MIN_FRAME_WIDTH) {
      return this.renderUnframed(width, titleStyled);
    }
    return this.renderFramed(width, titleStyled, screen);
  }

  /** Legacy, unframed layout: title, body at `width`, footer — used when `width` is too narrow to fit a frame (see `MIN_FRAME_WIDTH`). */
  private renderUnframed(width: number, titleStyled: string): string[] {
    this.framed = false;
    const lines: string[] = [titleStyled, ""];

    const bodyLines = this.body.render(width);
    this.bodyRowStart = lines.length;
    this.bodyRowCount = bodyLines.length;
    this.bodyWidth = width;
    lines.push(...bodyLines);
    lines.push("");

    const { line, spans } = renderFooter(this.hints, this.theme, this.hoveredHintIndex);
    this.hintSpans = spans;
    this.footerRowIndex = lines.length;
    lines.push(line);

    return lines;
  }

  /**
   * Rounded frame around the panel (see the module's "no padding/border"
   * feature doc, `odd/tasks/kankaku-panel.md`): a `╭─ <title> ─…─╮` top
   * border, one blank inner line, the body rendered at `innerWidth`
   * (`width - 4`), a blank inner line, the footer hints, and a `╰─…─╯`
   * bottom border. Every inner line is `│ <content> │`.
   */
  private renderFramed(width: number, titleStyled: string, screen: PanelScreenId): string[] {
    this.framed = true;
    const innerWidth = width - 4;
    const lines: string[] = [];

    lines.push(frameTop(this.theme, titleStyled, width));
    lines.push(frameLine(this.theme, "", innerWidth));

    const bodyLines = this.body.render(innerWidth);
    this.bodyRowStart = lines.length;
    this.bodyRowCount = bodyLines.length;
    this.bodyWidth = innerWidth;
    for (const bodyLine of bodyLines) lines.push(frameLine(this.theme, bodyLine, innerWidth));

    lines.push(frameLine(this.theme, "", innerWidth));

    const { line, spans } = renderFooter(this.hints, this.theme, this.hoveredHintIndex);
    // The footer's own hit-test spans are local to its (unframed) content;
    // shift them by the left border + padding so they match the actual
    // rendered column once wrapped in `frameLine`.
    this.hintSpans = spans.map((span) => ({ start: span.start + FRAME_LEFT_PADDING, end: span.end + FRAME_LEFT_PADDING }));
    this.footerRowIndex = lines.length;
    lines.push(frameLine(this.theme, line, innerWidth));

    lines.push(frameBottom(this.theme, width));

    return lines;
  }

  handleInput(data: string): void {
    // The shell owns Escape and left arrow itself; it never relies on
    // pi-tui's `SettingsList`/`SelectList` calling `onCancel` on its own
    // (via `getKeybindings().matches(data, "tui.select.cancel")`) — that
    // path does not reliably fire in the real TUI, which is the bug this
    // guards against. Only when the current body has explicitly captured
    // Escape (`PanelHost.setBodyCapturesEscape(true)` — an open submenu or
    // text field that must see the key itself, e.g. the target screen's
    // client/project/task submenus or its legacy-label `Input`) is the key
    // forwarded; otherwise the shell pops the current screen directly.
    if (matchesKey(data, Key.escape)) {
      if (this.bodyCapturesEscape) {
        this.body.handleInput?.(data);
      } else {
        this.goBack();
      }
      return;
    }
    if (matchesKey(data, Key.left)) {
      if (this.bodyCapturesEscape) {
        // Translate to the escape sequence so a captured body (which only
        // ever wires up Escape, not left arrow) closes exactly as it would
        // on Escape.
        this.body.handleInput?.("\x1b");
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
    if (!this.framed) {
      // Legacy, unframed layout: any non-footer row delegates as-is.
      return this.body.handleMouse?.(event);
    }
    const bodyRowEnd = this.bodyRowStart + this.bodyRowCount;
    if (event.y < this.bodyRowStart || event.y >= bodyRowEnd) {
      // Frame border or blank padding row: nothing to delegate to.
      return undefined;
    }
    return this.body.handleMouse?.({
      ...event,
      x: event.x - FRAME_LEFT_PADDING,
      y: event.y - this.bodyRowStart,
      width: this.bodyWidth,
    });
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
      // "esc" at root, "esc/←" on every other screen (see `footerHints`) —
      // `goBack()` already closes the panel outright when at root.
      if (hint.key.startsWith("esc")) {
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
