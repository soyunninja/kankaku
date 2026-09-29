/** The four screens of the app, in tab-bar order. */
export type ScreenId = "dashboard" | "tasks" | "catalog" | "sync";

export interface ScreenTab {
  id: ScreenId;
  label: string;
  /** The digit key (`1`-`4`) that switches to this screen. */
  key: string;
}

export const SCREENS: ScreenTab[] = [
  { id: "dashboard", label: "Dashboard", key: "1" },
  { id: "tasks", label: "Tasks", key: "2" },
  { id: "catalog", label: "Catalog", key: "3" },
  { id: "sync", label: "Sync", key: "4" },
];

/** The screen bound to `key` (one of `SCREENS`' digit keys), or `undefined` for any other key. */
export function screenForKey(key: string): ScreenId | undefined {
  return SCREENS.find((screen) => screen.key === key)?.id;
}

export interface TabBarItem {
  id: ScreenId;
  /** e.g. `"1 Today"`. */
  text: string;
  active: boolean;
}

/** One entry per screen for the tab bar, in `SCREENS` order, flagging which one is active. */
export function buildTabBar(active: ScreenId): TabBarItem[] {
  return SCREENS.map((screen) => ({ id: screen.id, text: `${screen.key} ${screen.label}`, active: screen.id === active }));
}

/**
 * The two focus zones of the app frame: the sidebar (moving between
 * screens) and the main content (working the active screen's own list
 * and actions). See `odd/tasks/visual-system.md`'s "Focus zones".
 */
export type Focus = "sidebar" | "main";

/**
 * The app's navigation state: the active screen, which zone has focus,
 * plus an optional Tasks project filter, set by `enter` on a Dashboard
 * project row and cleared with `esc`. Kept here (not in `app.tsx`) so it
 * stays a plain, testable value.
 */
export interface NavState {
  screen: ScreenId;
  focus: Focus;
  /** Restricts the Tasks screen to one project's rows; unset shows every project. */
  projectFilter?: string;
  /** Set while the active screen has a modal flow open (Tasks' reassignment picker): the app-level `esc`/`←`/`Tab` and screen-switch keys then stay out of its way. Absent otherwise. */
  modal?: boolean;
}

export const INITIAL_NAV_STATE: NavState = { screen: "dashboard", focus: "sidebar" };

/** Switch the active screen, keeping any existing project filter and focus (e.g. `1`-`4` while Tasks is already filtered). */
export function switchScreen(state: NavState, screen: ScreenId): NavState {
  return { ...state, screen };
}

/** `enter` on a Dashboard project row: jump to Tasks filtered to `project`, keeping the current focus. */
export function openProjectInTasks(state: NavState, project: string): NavState {
  return { ...state, screen: "tasks", projectFilter: project };
}

/** `esc` on Tasks: drop the project filter, keeping the current screen and focus. */
export function clearProjectFilter(state: NavState): NavState {
  const { projectFilter, ...rest } = state;
  void projectFilter;
  return rest;
}

/** Mark or clear the active screen's modal flow; clearing removes the key, so a state without a modal equals the plain one. */
export function setModal(state: NavState, open: boolean): NavState {
  if (open) return { ...state, modal: true };
  const { modal, ...rest } = state;
  void modal;
  return rest;
}

/** Focus the main content zone (e.g. `enter`/`→`/`Tab` from the sidebar). */
export function focusMain(state: NavState): NavState {
  return { ...state, focus: "main" };
}

/** Focus the sidebar zone (e.g. `←`/`Tab`/`esc` from the main content). */
export function focusSidebar(state: NavState): NavState {
  return { ...state, focus: "sidebar" };
}

/**
 * Move the active screen by `delta` positions in `SCREENS` order (sidebar
 * focused `↑`/`↓`), clamping at the first/last screen rather than
 * wrapping.
 */
export function moveSidebar(state: NavState, delta: number): NavState {
  const currentIndex = SCREENS.findIndex((screen) => screen.id === state.screen);
  const nextIndex = Math.min(Math.max(currentIndex + delta, 0), SCREENS.length - 1);
  const next = SCREENS[nextIndex];
  return next === undefined ? state : switchScreen(state, next.id);
}

/** One footer key hint: a key label and what it does. */
export interface NavKeyHint {
  key: string;
  label: string;
}

/** The fixed footer hints shown while the sidebar is focused. */
const SIDEBAR_HINTS: NavKeyHint[] = [
  { key: "↑↓", label: "choose" },
  { key: "enter/→", label: "open" },
  { key: "1-4", label: "screens" },
  { key: "q", label: "quit" },
];

/** Appended to a screen's own hints when the main zone is focused, to return to the sidebar. */
const MAIN_MENU_HINT: NavKeyHint = { key: "←", label: "menu" };

/**
 * The footer key hints for `screen` at the given `focus`: sidebar focus
 * always shows the fixed navigation hints (`extras` is ignored, since the
 * sidebar's own keys never depend on the active screen); main focus shows
 * the screen's own `extras` (its list/action keys) followed by `← menu`.
 */
export function hintsFor(screen: ScreenId, focus: Focus, extras: NavKeyHint[]): NavKeyHint[] {
  void screen;
  if (focus === "sidebar") return SIDEBAR_HINTS;
  return [...extras, MAIN_MENU_HINT];
}
