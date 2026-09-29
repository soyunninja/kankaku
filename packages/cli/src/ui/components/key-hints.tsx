import { Text } from "ink";
import { useTheme } from "../theme.ts";

export interface KeyHint {
  key: string;
  label: string;
}

export interface KeyHintsProps {
  hints: KeyHint[];
}

/** The footer key-hints line: `key` in the accent colour, `label` in muted, each pair separated by three spaces. */
export function KeyHints({ hints }: KeyHintsProps) {
  const theme = useTheme();
  return (
    <Text>
      {hints.map((hint, index) => (
        <Text key={`${hint.key}-${hint.label}`}>
          {index > 0 ? "   " : ""}
          <Text color={theme.accent}>{hint.key}</Text>
          <Text color={theme.muted}>{` ${hint.label}`}</Text>
        </Text>
      ))}
    </Text>
  );
}
