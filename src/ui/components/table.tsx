import { useRef } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme.ts";
import { windowRows } from "../../domain/list-window.ts";

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
  /**
   * Caps the number of rendered body lines (data rows plus any indicator
   * lines) to this many. When `rows.length` exceeds it, the viewport
   * follows `selectedIndex` (see `domain/list-window.ts#windowRows`) and
   * the first/last visible line is replaced by a `↑ N more` / `↓ N more`
   * indicator in `theme.muted` instead of a data row.
   */
  maxRows?: number;
}

/**
 * Resolves the visible slice of `rows` for a given `maxRows` body-line
 * budget: a data window sized so that, once indicator lines are added for
 * whichever side is hidden, the total body still fits `maxRows`. Converges
 * in at most two passes since adding an indicator can only ever remove
 * hidden rows on that same side.
 */
function resolveWindow(total: number, selected: number, maxRows: number, previousStart: number) {
  let budget = maxRows;
  let window = windowRows(total, selected, budget, previousStart);
  for (let pass = 0; pass < 2; pass += 1) {
    const reserve = (window.hiddenAbove > 0 ? 1 : 0) + (window.hiddenBelow > 0 ? 1 : 0);
    const nextBudget = Math.max(maxRows - reserve, 1);
    if (nextBudget === budget) break;
    budget = nextBudget;
    window = windowRows(total, selected, budget, previousStart);
  }
  return window;
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
export function Table<T>({ columns, rows, rowKey, cell, selectedIndex, emptyText = "no rows", maxRows }: TableProps<T>) {
  const theme = useTheme();
  const startRef = useRef(0);

  const windowed = maxRows !== undefined && rows.length > maxRows;
  const window = windowed ? resolveWindow(rows.length, selectedIndex ?? 0, maxRows, startRef.current) : undefined;
  if (window !== undefined) startRef.current = window.start;

  const visibleRows = window !== undefined ? rows.slice(window.start, window.end) : rows;

  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>{`  ${rowText(columns, (column) => column.header)}`}</Text>
      {rows.length === 0 ? (
        <Text color={theme.muted}>{emptyText}</Text>
      ) : (
        <>
          {window !== undefined && window.hiddenAbove > 0 && (
            <Text key="__indicator-above__" color={theme.muted}>{`  ↑ ${window.hiddenAbove} more`}</Text>
          )}
          {visibleRows.map((row, index) => {
            const actualIndex = (window?.start ?? 0) + index;
            const selected = actualIndex === selectedIndex;
            return (
              <Text key={rowKey(row)} backgroundColor={selected ? theme.selectionBg : undefined}>
                {`${selected ? "› " : "  "}${rowText(columns, (column) => cell(row, column.key))}`}
              </Text>
            );
          })}
          {window !== undefined && window.hiddenBelow > 0 && (
            <Text key="__indicator-below__" color={theme.muted}>{`  ↓ ${window.hiddenBelow} more`}</Text>
          )}
        </>
      )}
    </Box>
  );
}
