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
export function Panel({ title, headerRight, active = false, width, children }: PanelProps) {
  const theme = useTheme();
  const borderColor = active ? theme.borderActive : theme.border;
  const topBorder = buildTopBorder(title, headerRight, width);

  return (
    <Box flexDirection="column" width={Math.max(width, topBorder.length)}>
      <Text color={borderColor}>{topBorder}</Text>
      <Box flexDirection="column" borderStyle="round" borderTop={false} borderColor={borderColor} width={width}>
        {children}
      </Box>
    </Box>
  );
}
