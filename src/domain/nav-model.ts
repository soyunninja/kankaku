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
