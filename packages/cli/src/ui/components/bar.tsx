import { Text } from "ink";
import { useTheme } from "../theme.ts";

export interface BarProps {
  value: number;
  max: number;
  width: number;
  color?: string;
}

/** How many of `width` characters are filled for `value / max` (clamped to `[0, width]`; `max <= 0` is always `0`, never a division by zero). */
function filledWidth(value: number, max: number, width: number): number {
  const ratio = max > 0 ? value / max : 0;
  return Math.max(0, Math.min(width, Math.round(ratio * width)));
}

/** The plain-text form of a bar (`█` for the filled portion, `░` for the rest), reusable anywhere a coloured `<Bar>` element does not fit, e.g. a `Table` cell. */
export function renderBar(value: number, max: number, width: number): string {
  const filled = filledWidth(value, max, width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/** A `width`-character text bar: `█` for the filled portion (`value / max`, clamped to `[0, width]`), `░` for the rest. `max <= 0` renders fully empty rather than dividing by zero. */
export function Bar({ value, max, width, color }: BarProps) {
  const theme = useTheme();
  const filled = filledWidth(value, max, width);
  const empty = width - filled;
  return (
    <Text>
      <Text color={color ?? theme.accent}>{"█".repeat(filled)}</Text>
      <Text color={theme.muted}>{"░".repeat(empty)}</Text>
    </Text>
  );
}
