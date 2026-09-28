import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme.ts";

export interface RadioOption<T extends string = string> {
  value: T;
  label: string;
}

export interface RadioProps<T extends string = string> {
  options: RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
  focused: boolean;
}

/**
 * A single-select radio list: `(•) label` for the selected option, `( )
 * label` otherwise. ↑/↓ select the previous/next option directly (clamped
 * at the ends). The currently highlighted row also gets a visible `› `
 * marker, matching `Checklist`'s and `Table`'s own convention.
 */
export function Radio<T extends string = string>({ options, value, onChange, focused }: RadioProps<T>) {
  const theme = useTheme();
  const index = options.findIndex((option) => option.value === value);

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        const targetIndex = Math.max(index - 1, 0);
        const previous = options[targetIndex];
        if (previous && targetIndex !== index) onChange(previous.value);
        return;
      }
      if (key.downArrow) {
        const targetIndex = Math.min(index + 1, options.length - 1);
        const next = options[targetIndex];
        if (next && targetIndex !== index) onChange(next.value);
      }
    },
    { isActive: focused },
  );

  return (
    <Box flexDirection="column">
      {options.map((option, i) => (
        <Text key={option.value} color={theme.text}>
          {`${i === index ? "› " : "  "}${option.value === value ? "(•)" : "( )"} ${option.label}`}
        </Text>
      ))}
    </Box>
  );
}
