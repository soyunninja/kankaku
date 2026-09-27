import { Box, Text } from "ink";
import { useTheme } from "../theme.ts";

export interface TableColumn<T> {
  key: string;
  header: string;
  width: number;
  align?: "left" | "right";
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Cell text for `column.key` on `row`. Kept separate from `columns` so callers can share one column layout across differently-shaped rows. */
  cell: (row: T, key: string) => string;
  selectedIndex?: number;
  emptyText?: string;
}

/** Fit `text` into `width` visible columns: truncate with a trailing `…` when too long, then pad to `width` (left- or right-aligned). */
function fitCell(text: string, width: number, align: "left" | "right"): string {
  const value = text.length > width ? (width > 1 ? `${text.slice(0, width - 1)}…` : text.slice(0, width)) : text;
  const padding = " ".repeat(Math.max(width - value.length, 0));
  return align === "right" ? `${padding}${value}` : `${value}${padding}`;
}

function rowText<T>(columns: TableColumn<T>[], values: (column: TableColumn<T>) => string): string {
  return columns.map((column) => fitCell(values(column), column.width, column.align ?? "left")).join(" ");
}

/**
 * An aligned table: a muted header row, one line per data row prefixed with
 * `› ` on the selected row (a visible marker, never colour alone — see
 * AGENTS.md's ink-testing-library note) and `  ` otherwise. A cell wider
 * than its column truncates with `…`; `emptyText` renders instead of the
 * body when `rows` is empty.
 */
export function Table<T>({ columns, rows, rowKey, cell, selectedIndex, emptyText = "no rows" }: TableProps<T>) {
  const theme = useTheme();

  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>{`  ${rowText(columns, (column) => column.header)}`}</Text>
      {rows.length === 0 ? (
        <Text color={theme.muted}>{emptyText}</Text>
      ) : (
        rows.map((row, index) => {
          const selected = index === selectedIndex;
          return (
            <Text key={rowKey(row)} backgroundColor={selected ? theme.selectionBg : undefined}>
              {`${selected ? "› " : "  "}${rowText(columns, (column) => cell(row, column.key))}`}
            </Text>
          );
        })
      )}
    </Box>
  );
}
