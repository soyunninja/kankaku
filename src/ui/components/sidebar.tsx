import { Box, Text } from "ink";
import { useTheme } from "../theme.ts";

export interface SidebarItem {
  id: string;
  label: string;
  key: string;
}

export interface SidebarProps {
  items: SidebarItem[];
  activeId: string;
  /** Lines shown below a divider, under the nav items (e.g. `"roots 1"`, `"projects 3"`). */
  stats: string[];
  width: number;
  /** Whether the sidebar zone itself has focus: the active item's marker and label use `theme.accent` when `true`, `theme.muted` when `false`. Defaults to `true`. */
  focused?: boolean;
}

/**
 * The left-hand navigation column: one line per {@link SidebarItem} (the
 * active one prefixed `› `, others `  ` — a visible marker rather than
 * colour alone), a divider, then `stats`. Ink's `Box` border draws around
 * the whole column, so the divider is a plain `─` fill line rather than a
 * true `├─…─┤` junction.
 */
export function Sidebar({ items, activeId, stats, width, focused = true }: SidebarProps) {
  const theme = useTheme();
  const inner = Math.max(width - 2, 1);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.border} width={width}>
      {items.map((item) => (
        <Text
          key={item.id}
          color={item.id === activeId ? (focused ? theme.accent : theme.muted) : theme.text}
          bold={item.id === activeId}
        >
          {`${item.id === activeId ? "› " : "  "}${item.label}`}
        </Text>
      ))}
      <Text color={theme.border}>{"─".repeat(inner)}</Text>
      {stats.map((line, index) => (
        <Text key={index} color={theme.muted}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
