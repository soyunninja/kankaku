import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme.ts";

export interface PanelProps {
  title: string;
  /** Right-aligned text on the same top-border line, before the closing corner. */
  headerRight?: string;
  /** Uses `theme.borderActive` instead of `theme.border`. */
  active?: boolean;
  width: number;
  /** Fixed total height (including both border lines). When set, the body clips instead of growing past it. */
  height?: number;
  /** Passed through to the outer `Box` so a panel can stretch to fill available vertical space in a flex layout. */
  flexGrow?: number;
  children?: ReactNode;
}

/**
 * Build the top border as `╭─[ Title ]───…───headerRight╮`. Ink's `Box`
 * has no title-in-border support, so this line is rendered as plain text
 * above a `Box` whose own top border is turned off (`borderTop={false}`).
 * Never shrinks below what `title`/`headerRight` need, even past `width`.
 */
function buildTopBorder(title: string, headerRight: string | undefined, width: number): string {
  const left = `─[ ${title} ]`;
  const right = headerRight ? `${headerRight} ` : "";
  const minWidth = left.length + right.length + 2;
  const total = Math.max(width, minWidth);
  const fill = total - left.length - right.length - 2;
  return `╭${left}${"─".repeat(Math.max(fill, 0))}${right}╮`;
}

/**
 * A rounded, titled panel: the title sits inside the top border, an
 * optional `headerRight` note sits right-aligned on the same line, and
 * `children` render inside a rounded frame below it. `active` swaps the
 * border colour to `theme.borderActive` (e.g. the focused panel in a
 * multi-panel screen).
 */
export function Panel({ title, headerRight, active = false, width, height, flexGrow, children }: PanelProps) {
  const theme = useTheme();
  const borderColor = active ? theme.borderActive : theme.border;
  const topBorder = buildTopBorder(title, headerRight, width);
  /** The top border is its own line above the bordered box, so the box's own height (which includes its bottom border) is one row less than the panel's total. */
  const bodyHeight = height !== undefined ? Math.max(height - 1, 1) : undefined;

  return (
    <Box flexDirection="column" width={Math.max(width, topBorder.length)} height={height} flexGrow={flexGrow}>
      <Text color={borderColor}>{topBorder}</Text>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderTop={false}
        borderColor={borderColor}
        width={width}
        height={bodyHeight}
        flexGrow={flexGrow !== undefined ? 1 : undefined}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  );
}
