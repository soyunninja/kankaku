import { Text } from "ink";
import { useTheme } from "../theme.ts";

const LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export interface SparklineProps {
  values: number[];
  color?: string;
}

/** One block character per value (`▁`–`█`), scaled to the series' own max. An empty series renders `·`; an all-zero series renders every bar at the lowest level rather than collapsing to nothing. */
export function Sparkline({ values, color }: SparklineProps) {
  const theme = useTheme();
  if (values.length === 0) return <Text color={theme.muted}>·</Text>;

  const max = Math.max(...values, 0);
  const text = values
    .map((value) => {
      const ratio = max > 0 ? value / max : 0;
      const level = Math.max(0, Math.min(LEVELS.length - 1, Math.round(ratio * (LEVELS.length - 1))));
      return LEVELS[level];
    })
    .join("");

  return <Text color={color ?? theme.accent}>{text}</Text>;
}
