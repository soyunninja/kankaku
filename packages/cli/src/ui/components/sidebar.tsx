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
 *
 * `focused` makes the focused zone unmistakable (see the "the menu column
 * does not show as marked" fix in the project's task notes): the column's
 * own border switches to `theme.borderActive`, and the active item gets a
 * full-row `theme.selectionBg` highlight — its label is padded to the
 * column's inner width first, since a `Text` background colour only
 * covers its own rendered characters, not the blank cells Ink's fixed-width
 * border box fills in around a shorter string. Unfocused, the active item
 * keeps its plain `›` marker in `theme.muted` with no background — a
 * structural marker, not colour alone, stays the primary cue either way.
 */
export function Sidebar({ items, activeId, stats, width, focused = true }: SidebarProps) {
  const theme = useTheme();
  const inner = Math.max(width - 2, 1);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={focused ? theme.borderActive : theme.border} width={width}>
      {items.map((item) => {
        const active = item.id === activeId;
        const marker = active ? "› " : "  ";
        const label = active && focused ? `${marker}${item.label}`.padEnd(inner) : `${marker}${item.label}`;
        return (
          <Text
            key={item.id}
            color={active ? (focused ? theme.accent : theme.muted) : theme.text}
            backgroundColor={active && focused ? theme.selectionBg : undefined}
            bold={active && focused}
          >
            {label}
          </Text>
        );
      })}
      <Text color={theme.border}>{"─".repeat(inner)}</Text>
      {stats.map((line, index) => (
        <Text key={index} color={theme.muted}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
