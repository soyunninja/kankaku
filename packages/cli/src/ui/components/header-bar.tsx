import { Box, Text } from "ink";
import { useTheme } from "../theme.ts";

export interface HeaderBarProps {
  /** App name/version, e.g. `">_ kankaku 0.1.0"`. */
  left: string;
  /** Hub/status text, right-aligned. Omitted entirely when unset. */
  right?: string;
  width: number;
}

/** The top header line: `left` and `right` at opposite ends of `width`, via flex `space-between` rather than manual padding. */
export function HeaderBar({ left, right, width }: HeaderBarProps) {
  const theme = useTheme();
  return (
    <Box width={width} justifyContent="space-between">
      <Text bold color={theme.text}>
        {left}
      </Text>
      {right !== undefined && <Text color={theme.muted}>{right}</Text>}
    </Box>
  );
}
