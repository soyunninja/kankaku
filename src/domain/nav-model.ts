/** The four screens of the app, in tab-bar order. */
export type ScreenId = "today" | "tasks" | "catalog" | "sync";

export interface ScreenTab {
  id: ScreenId;
  label: string;
  /** The digit key (`1`-`4`) that switches to this screen. */
  key: string;
}

export const SCREENS: ScreenTab[] = [
  { id: "today", label: "Today", key: "1" },
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
 * The app's navigation state: the active screen plus an optional Tasks
 * project filter, set by `enter` on a Today project row and cleared with
 * `esc`. Kept here (not in `app.tsx`) so it stays a plain, testable value.
 */
export interface NavState {
  screen: ScreenId;
  /** Restricts the Tasks screen to one project's rows; unset shows every project. */
  projectFilter?: string;
}

export const INITIAL_NAV_STATE: NavState = { screen: "today" };

/** Switch the active screen, keeping any existing project filter (e.g. `1`-`4` while Tasks is already filtered). */
export function switchScreen(state: NavState, screen: ScreenId): NavState {
  return { ...state, screen };
}

/** `enter` on a Today project row: jump to Tasks filtered to `project`. */
export function openProjectInTasks(state: NavState, project: string): NavState {
  void state;
  return { screen: "tasks", projectFilter: project };
}

/** `esc` on Tasks: drop the project filter, keeping the current screen. */
export function clearProjectFilter(state: NavState): NavState {
  const { projectFilter, ...rest } = state;
  void projectFilter;
  return rest;
}
