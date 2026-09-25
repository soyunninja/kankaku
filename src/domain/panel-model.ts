/**
 * Pure model for the `/kankaku` panel (see odd/tasks/kankaku-panel.md): the
 * set of screens, the root menu, an immutable navigation stack, and the
 * title/footer-hint text every adapter screen renders from. No I/O, no pi
 * imports — see AGENTS.md "Architecture (hexagonal)".
 */

export type PanelScreenId = "root" | "target" | "report" | "sync" | "export" | "doctor" | "about";

/** One row of the root menu (`rootMenu`): a section the panel can navigate to. */
export interface PanelMenuItem {
  id: PanelScreenId;
  label: string;
  description: string;
  /** Offered only when the hub (PocketBase) is configured; see {@link rootMenu}. */
  hubOnly: boolean;
}

const ROOT_MENU_ITEMS: PanelMenuItem[] = [
  { id: "target", label: "Target", description: "Billing client, project, hub task, legacy label", hubOnly: true },
  { id: "report", label: "Report", description: "Today/all totals, tasks, sessions, clients, projects", hubOnly: false },
  { id: "sync", label: "Sync", description: "Status, sync now, sync all, backfill, catalog refresh", hubOnly: true },
  { id: "export", label: "Export", description: "Write today's or every task as csv/json", hubOnly: false },
  { id: "doctor", label: "Doctor", description: "Orphan/uncertain subagent counts, ancestor detection", hubOnly: false },
  { id: "about", label: "About", description: "Versions, KANKAKU_DIR, env-only config", hubOnly: false },
];

/**
 * The root menu's rows, in a fixed order. `hubOnly` rows (`target`, `sync`)
 * are omitted entirely when the hub is not configured, so the panel offers
 * exactly what `/kankaku` itself would today.
 */
export function rootMenu(options: { hubConfigured: boolean }): PanelMenuItem[] {
  return ROOT_MENU_ITEMS.filter((item) => options.hubConfigured || !item.hubOnly);
}

/** Immutable navigation stack: `stack[0]` is always `"root"`. */
export interface PanelNav {
  stack: PanelScreenId[];
}

/** A fresh navigation stack, positioned at the root screen. */
export function navRoot(): PanelNav {
  return { stack: ["root"] };
}

/** Push a screen onto the stack, returning a new {@link PanelNav}; the input is never mutated. */
export function navPush(nav: PanelNav, id: PanelScreenId): PanelNav {
  return { stack: [...nav.stack, id] };
}

/**
 * Pop the current screen, returning a new {@link PanelNav} and whether the
 * panel should close. At the root, there is nothing left to pop: the stack
 * is returned unchanged and `closed` is `true` — the caller closes the
 * overlay instead of navigating.
 */
export function navBack(nav: PanelNav): { nav: PanelNav; closed: boolean } {
  if (nav.stack.length <= 1) {
    return { nav, closed: true };
  }
  return { nav: { stack: nav.stack.slice(0, -1) }, closed: false };
}

/** The screen currently on top of the stack. */
export function navCurrent(nav: PanelNav): PanelScreenId {
  return nav.stack[nav.stack.length - 1] ?? "root";
}

const SCREEN_TITLES: Record<Exclude<PanelScreenId, "root">, string> = {
  target: "Target",
  report: "Report",
  sync: "Sync",
  export: "Export",
  doctor: "Doctor",
  about: "About",
};

/** `kankaku` at root, `kankaku · <Screen>` on every other screen. */
export function panelTitle(screen: PanelScreenId): string {
  if (screen === "root") return "kankaku";
  return `kankaku · ${SCREEN_TITLES[screen]}`;
}

/** One clickable/keyboard hint shown in the panel's footer. */
export interface PanelHint {
  key: string;
  label: string;
}

/**
 * The footer hint row for a screen: navigation hints, an optional search
 * hint when the current body supports it, and how Escape/`q` behave — back
 * at root closes the panel outright, so root shows only `esc close`; every
 * other screen shows both `esc back` and `q close`.
 */
export function footerHints(screen: PanelScreenId, options: { searchable: boolean }): PanelHint[] {
  const hints: PanelHint[] = [{ key: "↑↓", label: "move" }];

  if (screen === "root") {
    hints.push({ key: "enter", label: "open" });
    if (options.searchable) hints.push({ key: "/", label: "search" });
    hints.push({ key: "esc", label: "close" });
    return hints;
  }

  hints.push({ key: "enter", label: "select" });
  if (options.searchable) hints.push({ key: "/", label: "search" });
  hints.push({ key: "esc", label: "back" }, { key: "q", label: "close" });
  return hints;
}
