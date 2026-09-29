import { Text } from "ink";
import { pickerHeading, pickerRows, pickerTitle } from "../domain/reassign-picker.ts";
import type { PickerRow, PickerState, PickerStep } from "../domain/reassign-picker.ts";
import { Panel } from "./components/panel.tsx";
import { Table } from "./components/table.tsx";
import { useTheme } from "./theme.ts";

/** Rows the panel's own chrome takes (top border line + bottom border) plus the two heading lines and the table's header line. */
const PICKER_FIXED_ROWS = 2 + 2 + 1;
/** Columns the panel border (2) and the table's `› ` marker (2) take from the panel width. */
const PICKER_FIXED_COLUMNS = 4;

const COLUMN_HEADERS: Record<PickerStep, string> = {
  client: "client",
  project: "project",
  task: "task",
  review: "change",
  applying: "sending",
  result: "result",
};

/** How many list lines fit a picker panel of `height` rows (at least one, so a tiny terminal still tracks the selection). */
export function pickerMaxRows(height: number): number {
  return Math.max(height - PICKER_FIXED_ROWS, 1);
}

/**
 * The reassignment picker, drawn as one fixed-size `Panel` over the Tasks
 * screen's content zone: two heading lines, then the current step's list
 * in a windowed `Table` (the same scrolling and `↑ N more`/`↓ N more`
 * indicators as every other list). The panel's `height` is fixed by the
 * caller, so a long list scrolls inside it and never grows the frame.
 */
export function ReassignPanel({ state, width, height }: { state: PickerState; width: number; height: number }) {
  const theme = useTheme();
  const [headline, detail] = pickerHeading(state);
  const rows: Array<PickerRow & { key: string }> = pickerRows(state).map((entry, index) => ({ ...entry, key: String(index) }));
  const textWidth = Math.max(width - PICKER_FIXED_COLUMNS, 1);

  return (
    <Panel title={pickerTitle(state)} width={width} height={height} active>
      <Text wrap="truncate-end">{headline}</Text>
      <Text color={theme.muted} wrap="truncate-end">
        {detail === "" ? " " : detail}
      </Text>
      <Table
        key={state.step}
        columns={[{ key: "text", header: COLUMN_HEADERS[state.step], width: textWidth }]}
        rows={rows}
        rowKey={(row) => row.key}
        cell={(row) => row.text}
        rowColor={(row) => (row.tone === "error" ? theme.error : row.tone === "muted" ? theme.muted : undefined)}
        selectedIndex={state.index}
        emptyText="nothing to choose from"
        maxRows={pickerMaxRows(height)}
      />
    </Panel>
  );
}
