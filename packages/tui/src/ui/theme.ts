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
  /** Even more de-emphasised than `muted` — e.g. a busy/waiting note. */
  dim: string;
  ok: string;
  warn: string;
  error: string;
  /** Background colour for a selected table/list row. */
  selectionBg: string;
}

/**
 * The three built-in presets: resolved hex values copied from
 * [gentle-pi](https://github.com/Gentleman-Programming/gentle-pi)'s own
 * themes (MIT), so this TUI's palette matches the owner's pi panel instead
 * of an unrelated default. `gentle-pi/themes/GentlemanSexy.json`.
 */
export const GENTLEMAN_SEXY_THEME: Theme = {
  accent: "#F43888",
  border: "#563040",
  borderActive: "#FF4F9A",
  text: "#F6EFF3",
  muted: "#A78E9B",
  dim: "#76616B",
  ok: "#D2CBD0",
  warn: "#F2B86D",
  error: "#FF718F",
  selectionBg: "#28121E",
};

/** `gentle-pi/themes/GentlemanCute.json` (MIT) — resolved hex values. */
export const GENTLEMAN_CUTE_THEME: Theme = {
  accent: "#F095C8",
  border: "#563040",
  borderActive: "#FFB1DD",
  text: "#F6EFF3",
  muted: "#A78E9B",
  dim: "#76616B",
  ok: "#B4E7C7",
  warn: "#F2B86D",
  error: "#FF718F",
  selectionBg: "#28121E",
};

/** `gentle-pi/themes/Gentle.json` (MIT) — resolved hex values. */
export const GENTLE_THEME: Theme = {
  accent: "#7FB4CA",
  border: "#313342",
  borderActive: "#7FB4CA",
  text: "#F3F6F9",
  muted: "#5C6170",
  dim: "#5C6170",
  ok: "#B7CC85",
  warn: "#DEBA87",
  error: "#CB7C94",
  selectionBg: "#232A40",
};

/** Every built-in preset's selectable name, in the order `resolveTheme`'s usage error lists them. */
export const THEME_NAMES = ["gentleman-sexy", "gentleman-cute", "gentle"] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

/** Every built-in preset, keyed by its selectable `ThemeName`. */
export const THEMES: Record<ThemeName, Theme> = {
  "gentleman-sexy": GENTLEMAN_SEXY_THEME,
  "gentleman-cute": GENTLEMAN_CUTE_THEME,
  gentle: GENTLE_THEME,
};

/** The default preset when no `--theme`/`KANKAKU_TUI_THEME` is given: the owner's own pi theme. */
export const DEFAULT_THEME: Theme = GENTLEMAN_SEXY_THEME;

export type ResolveThemeResult = { ok: true; theme: Theme } | { ok: false; reason: string };

/**
 * Resolve a `--theme`/`KANKAKU_TUI_THEME` name (see `cli.tsx`) to its
 * `Theme` preset. An unknown name fails with a usage error listing every
 * valid `THEME_NAMES` entry, rather than silently falling back to a
 * default — pure, so it's testable without rendering anything.
 */
export function resolveTheme(name: string): ResolveThemeResult {
  const theme = THEMES[name as ThemeName];
  if (theme === undefined) {
    return { ok: false, reason: `unknown theme "${name}"; choose one of: ${THEME_NAMES.join(", ")}` };
  }
  return { ok: true, theme };
}

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
