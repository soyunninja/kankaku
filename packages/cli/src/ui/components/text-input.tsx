import { useState } from "react";
import { Text, useInput } from "ink";
import { useTheme } from "../theme.ts";

export interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  /** Renders every character as `•` (a password field). */
  masked?: boolean;
  focused: boolean;
}

/**
 * A single-line, fully controlled text input: printable characters insert
 * at the cursor, Backspace/Delete remove the character before/after it,
 * ←/→ and Home/End move it, Enter calls `onSubmit`. Only active while
 * `focused` (`useInput`'s own `isActive`, matching every other kankaku
 * component). The cursor is a visible `▏` marker, shown only while
 * focused — never colour alone (see AGENTS.md's ink-testing-library note).
 */
export function TextInput({ value, onChange, onSubmit, placeholder = "", masked = false, focused }: TextInputProps) {
  const theme = useTheme();
  const [cursor, setCursor] = useState(value.length);
  const position = Math.min(Math.max(cursor, 0), value.length);

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.leftArrow) {
        setCursor(Math.max(position - 1, 0));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(position + 1, value.length));
        return;
      }
      if (key.home) {
        setCursor(0);
        return;
      }
      if (key.end) {
        setCursor(value.length);
        return;
      }
      if (key.backspace) {
        if (position === 0) return;
        onChange(value.slice(0, position - 1) + value.slice(position));
        setCursor(position - 1);
        return;
      }
      if (key.delete) {
        if (position >= value.length) return;
        onChange(value.slice(0, position) + value.slice(position + 1));
        return;
      }
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.tab || key.escape || key.ctrl || key.meta) return;
      if (!input) return;
      onChange(value.slice(0, position) + input + value.slice(position));
      setCursor(position + input.length);
    },
    { isActive: focused },
  );

  const cursorMark = focused ? "▏" : "";

  if (value.length === 0) {
    return (
      <Text>
        {cursorMark}
        <Text color={theme.dim}>{placeholder}</Text>
      </Text>
    );
  }

  const displayed = masked ? "•".repeat(value.length) : value;
  return (
    <Text>
      {displayed.slice(0, position)}
      {cursorMark}
      {displayed.slice(position)}
    </Text>
  );
}
