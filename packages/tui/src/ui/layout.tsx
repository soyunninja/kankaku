import type { ReactNode } from "react";
import { Box, Text, useStdout } from "ink";
import { HeaderBar } from "./components/header-bar.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import type { SidebarItem } from "./components/sidebar.tsx";
import { KeyHints } from "./components/key-hints.tsx";
import type { KeyHint } from "./components/key-hints.tsx";
import { useTheme } from "./theme.ts";
import type { Focus } from "../domain/nav-model.ts";

/** Sidebar width in the wide (side-by-side) layout. */
const SIDEBAR_WIDTH = 16;
/** Below this width, the main content stacks under a full-width sidebar instead of sitting beside it. */
const STACK_BREAKPOINT = 100;
/** Below this width, the sidebar collapses to a one-line tab strip. */
const COLLAPSE_BREAKPOINT = 70;
/** Rows used by the header line. */
const HEADER_ROWS = 1;
/** Rows used by the footer key-hints line. */
const FOOTER_ROWS = 1;
/** Rows used by the collapsed mode's one-line tab strip. */
const TAB_STRIP_ROWS = 1;
/** Fallback terminal height when neither `rows` nor `useStdout().rows` is available (e.g. a non-TTY test double). */
const DEFAULT_ROWS = 24;

export type LayoutMode = "wide" | "stacked" | "collapsed";

export interface LayoutRenderArgs {
  /** Width available to the main content area in the current mode. */
  mainWidth: number;
  /** Height (in rows) available to the main content area, after the header, footer and (in stacked/collapsed mode) the sidebar/tab strip. Screens use this to size their scrolling lists. */
  mainHeight: number;
  mode: LayoutMode;
}

/** Total rows the {@link Sidebar} block occupies in stacked mode: nav items, the divider, the stats lines, and its own top/bottom border. */
function sidebarBlockRows(itemCount: number, statsCount: number): number {
  return itemCount + 1 + statsCount + 2;
}

export interface LayoutProps {
  /** Forced terminal width; falls back to `useStdout()`, then 80. Lets tests force a specific breakpoint. */
  columns?: number;
  /** Forced terminal height; falls back to `useStdout()`, then {@link DEFAULT_ROWS}. Drives the root `Box`'s height and `mainHeight`, so the app fills the whole terminal (used with Ink's `alternateScreen`). */
  rows?: number;
  headerLeft: string;
  headerRight?: string;
  sidebarItems: SidebarItem[];
  activeId: string;
  sidebarStats: string[];
  keyHints: KeyHint[];
  /** Which zone has focus (see `domain/nav-model.ts`'s "Focus zones"); colours the sidebar's active-item marker. Defaults to `"sidebar"`. */
  focus?: Focus;
  children: (args: LayoutRenderArgs) => ReactNode;
}

function TabStrip({ items, activeId }: { items: SidebarItem[]; activeId: string }) {
  const theme = useTheme();
  return (
    <Text>
      {items.map((item, index) => (
        <Text key={item.id}>
          {index > 0 ? " · " : ""}
          <Text color={item.id === activeId ? theme.accent : theme.text} bold={item.id === activeId}>
            {item.id === activeId ? `[${item.label}]` : item.label}
          </Text>
        </Text>
      ))}
    </Text>
  );
}

/**
 * The app frame: header line, sidebar + main content, footer key hints,
 * filling the whole terminal height (`rows`, from `useStdout()` when not
 * given). Responsive to `columns` (from `useStdout()` when not given, so
 * tests can force a width): at 100+ columns the sidebar sits beside main;
 * at 70-99 columns main stacks under a full-width sidebar; below 70
 * columns the sidebar collapses to a one-line tab strip. The middle row
 * (everything between the header and the footer) grows to fill whatever
 * height is left, `useStdout()` re-renders this component on a terminal
 * resize, and `children` is a render function so a screen can size its
 * own panels and scrolling lists to the actual `mainWidth`/`mainHeight`
 * in whichever mode is active.
 */
export function Layout({ columns, rows, headerLeft, headerRight, sidebarItems, activeId, sidebarStats, keyHints, focus = "sidebar", children }: LayoutProps) {
  const { stdout } = useStdout();
  const width = columns ?? stdout?.columns ?? 80;
  const height = rows ?? stdout?.rows ?? DEFAULT_ROWS;
  const sidebarFocused = focus === "sidebar";

  const mode: LayoutMode = width < COLLAPSE_BREAKPOINT ? "collapsed" : width < STACK_BREAKPOINT ? "stacked" : "wide";
  const mainWidth = mode === "wide" ? Math.max(width - SIDEBAR_WIDTH, 1) : width;

  const middleRows = Math.max(height - HEADER_ROWS - FOOTER_ROWS, 0);
  const chromeRows =
    mode === "collapsed" ? TAB_STRIP_ROWS : mode === "stacked" ? sidebarBlockRows(sidebarItems.length, sidebarStats.length) : 0;
  const mainHeight = Math.max(middleRows - chromeRows, 0);

  const content = children({ mainWidth, mainHeight, mode });

  return (
    <Box flexDirection="column" width={width} height={height}>
      <HeaderBar left={headerLeft} right={headerRight} width={width} />
      {mode === "collapsed" && (
        <Box flexDirection="column" flexGrow={1} minHeight={0}>
          <TabStrip items={sidebarItems} activeId={activeId} />
          <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            {content}
          </Box>
        </Box>
      )}
      {mode === "stacked" && (
        <Box flexDirection="column" flexGrow={1} minHeight={0}>
          <Sidebar items={sidebarItems} activeId={activeId} stats={sidebarStats} width={width} focused={sidebarFocused} />
          <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            {content}
          </Box>
        </Box>
      )}
      {mode === "wide" && (
        <Box flexDirection="row" flexGrow={1} minHeight={0} alignItems="stretch">
          <Sidebar items={sidebarItems} activeId={activeId} stats={sidebarStats} width={SIDEBAR_WIDTH} focused={sidebarFocused} />
          <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            {content}
          </Box>
        </Box>
      )}
      <KeyHints hints={keyHints} />
    </Box>
  );
}
