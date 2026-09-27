import { createContext, createElement, useContext } from "react";
import type { ReactNode } from "react";

/** One colour role per visual concern, shared by every component in `src/ui/components/`. */
export interface Theme {
  /** Primary accent — active tab, key hints' key, sparkline highlight. */
  accent: string;
  /** Default panel/sidebar border colour. */
  border: string;
  /** Border colour for the focused/active panel. */
  borderActive: string;
  /** Default text colour. */
  text: string;
  /** De-emphasised text — table headers, footer labels, secondary notes. */
  muted: string;
  ok: string;
  warn: string;
  error: string;
  /** Background colour for a selected table/list row. */
  selectionBg: string;
}

/** The single built-in preset: dark background, cyan accent. */
export const DEFAULT_THEME: Theme = {
  accent: "cyan",
  border: "gray",
  borderActive: "cyan",
  text: "white",
  muted: "gray",
  ok: "green",
  warn: "yellow",
  error: "red",
  selectionBg: "blue",
};

const ThemeContext = createContext<Theme>(DEFAULT_THEME);

export interface ThemeProviderProps {
  /** Defaults to {@link DEFAULT_THEME} — swapping presets (e.g. a future `--theme` flag) only needs a different value here. */
  theme?: Theme;
  children?: ReactNode;
}

/**
 * Provides a {@link Theme} to its subtree via context. Written with
 * `createElement` (not JSX) so this file can stay a plain `.ts` module, as
 * named in `odd/tasks/visual-system.md`.
 */
export function ThemeProvider({ theme = DEFAULT_THEME, children }: ThemeProviderProps) {
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

/** The current {@link Theme}: the nearest {@link ThemeProvider}'s value, or {@link DEFAULT_THEME} outside one. */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
