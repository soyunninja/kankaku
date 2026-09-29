import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme.ts";

export interface ChecklistItem {
  id: string;
  label: string;
  checked: boolean;
  /** Disabled rows render `[-] label (note)` and never toggle. */
  disabled?: boolean;
  note?: string;
}

export interface ChecklistProps {
  items: ChecklistItem[];
  cursor: number;
  onToggle: (id: string) => void;
  onMove: (delta: number) => void;
  focused: boolean;
}

/**
 * A checkbox list: `[x] label` checked, `[ ] label` unchecked, `[-] label
 * (note)` disabled. Space toggles the item at `cursor` (a no-op when
 * disabled); ↑/↓ call `onMove(-1|1)` — clamping is the caller's job, same
 * as `Table`'s `selectedIndex`. The cursor row gets a visible `› ` marker,
 * never colour alone.
 */
export function Checklist({ items, cursor, onToggle, onMove, focused }: ChecklistProps) {
  const theme = useTheme();

  useInput(
    (input, key) => {
      if (key.upArrow) {
        onMove(-1);
        return;
      }
      if (key.downArrow) {
        onMove(1);
        return;
      }
      if (input === " ") {
        const item = items[cursor];
        if (item && !item.disabled) onToggle(item.id);
      }
    },
    { isActive: focused },
  );

  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        const marker = item.disabled ? "[-]" : item.checked ? "[x]" : "[ ]";
        const note = item.disabled && item.note ? ` (${item.note})` : "";
        const cursorMark = index === cursor ? "› " : "  ";
        return (
          <Text key={item.id} color={item.disabled ? theme.dim : theme.text}>
            {`${cursorMark}${marker} ${item.label}${note}`}
          </Text>
        );
      })}
    </Box>
  );
}
