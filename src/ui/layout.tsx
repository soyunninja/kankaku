import type { ReactNode } from "react";
import { Box, Text, useStdout } from "ink";
import { HeaderBar } from "./components/header-bar.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import type { SidebarItem } from "./components/sidebar.tsx";
import { KeyHints } from "./components/key-hints.tsx";
import type { KeyHint } from "./components/key-hints.tsx";
import { useTheme } from "./theme.ts";

/** Sidebar width in the wide (side-by-side) layout. */
const SIDEBAR_WIDTH = 16;
/** Below this width, the main content stacks under a full-width sidebar instead of sitting beside it. */
const STACK_BREAKPOINT = 100;
/** Below this width, the sidebar collapses to a one-line tab strip. */
const COLLAPSE_BREAKPOINT = 70;

export type LayoutMode = "wide" | "stacked" | "collapsed";

export interface LayoutRenderArgs {
  /** Width available to the main content area in the current mode. */
  mainWidth: number;
  mode: LayoutMode;
}

export interface LayoutProps {
  /** Forced terminal width; falls back to `useStdout()`, then 80. Lets tests force a specific breakpoint. */
  columns?: number;
  /** Forced terminal height; falls back to `useStdout()`. Currently unused by layout decisions, reserved for a future vertical mode. */
  rows?: number;
  headerLeft: string;
  headerRight?: string;
  sidebarItems: SidebarItem[];
  activeId: string;
  sidebarStats: string[];
  keyHints: KeyHint[];
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
 * The app frame: header line, sidebar + main content, footer key hints.
 * Responsive to `columns` (from `useStdout()` when not given, so tests can
 * force a width): at 100+ columns the sidebar sits beside main; at 70-99
 * columns main stacks under a full-width sidebar; below 70 columns the
 * sidebar collapses to a one-line tab strip. `children` is a render
 * function so a screen can size its own panels to the actual `mainWidth`
 * in whichever mode is active.
 */
export function Layout({ columns, headerLeft, headerRight, sidebarItems, activeId, sidebarStats, keyHints, children }: LayoutProps) {
  const { stdout } = useStdout();
  const width = columns ?? stdout?.columns ?? 80;

  const mode: LayoutMode = width < COLLAPSE_BREAKPOINT ? "collapsed" : width < STACK_BREAKPOINT ? "stacked" : "wide";
  const mainWidth = mode === "wide" ? Math.max(width - SIDEBAR_WIDTH, 1) : width;

  const content = children({ mainWidth, mode });

  return (
    <Box flexDirection="column" width={width}>
      <HeaderBar left={headerLeft} right={headerRight} width={width} />
      {mode === "collapsed" && (
        <Box flexDirection="column">
          <TabStrip items={sidebarItems} activeId={activeId} />
          <Box flexDirection="column">{content}</Box>
        </Box>
      )}
      {mode === "stacked" && (
        <Box flexDirection="column">
          <Sidebar items={sidebarItems} activeId={activeId} stats={sidebarStats} width={width} />
          <Box flexDirection="column">{content}</Box>
        </Box>
      )}
      {mode === "wide" && (
        <Box flexDirection="row">
          <Sidebar items={sidebarItems} activeId={activeId} stats={sidebarStats} width={SIDEBAR_WIDTH} />
          <Box flexDirection="column" flexGrow={1}>
            {content}
          </Box>
        </Box>
      )}
      <KeyHints hints={keyHints} />
    </Box>
  );
}
