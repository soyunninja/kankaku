import { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatMinutes } from "../domain/today-model.ts";
import type { TaskRow, TasksModel } from "../domain/tasks-model.ts";
import { SCREENS, hintsFor } from "../domain/nav-model.ts";
import { wrapText } from "../domain/text-wrap.ts";
import { Layout } from "./layout.tsx";
import { Panel } from "./components/panel.tsx";
import { Table } from "./components/table.tsx";
import type { TableColumn } from "./components/table.tsx";
import { useTheme } from "./theme.ts";

export interface TasksScreenProps {
  load: (options: { all: boolean }) => TasksModel;
  roots: string[];
  version: string;
  columns?: number;
  rows?: number;
  /** Whether the main zone (this screen) has focus; when `false`, this screen's own list/action keys are inert. Defaults to `true` for a standalone render. */
  focused?: boolean;
  /** Restrict the table to one project's rows (set by `enter` on a Today project row). */
  projectFilter?: string;
  /** `esc`: drop `projectFilter`. Omitted when the caller does not wire navigation. */
  onClearFilter?: () => void;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

/** Combined width of every fixed-width column plus their separating spaces, the row's own `› `/`  ` marker prefix, and the panel's own left/right border columns — everything the `prompt` column does not own. */
const TASK_FIXED_COLUMNS_WIDTH = 5 + 1 + 12 + 1 + 7 + 1 + 6 + 1 + 2 + 2;
/** Floor for the `prompt` column so a very narrow table still shows a sliver of text instead of collapsing to nothing. */
const MIN_PROMPT_WIDTH = 4;

/**
 * `time`/`project`/`work`/`cost` are fixed-width; `prompt` absorbs
 * whatever width is left in `tableWidth` (the panel's own outer width,
 * including its border columns) so the row's total text never exceeds
 * the panel's actual content width — which would otherwise wrap inside
 * the fixed-height, `overflow: hidden` panel and silently eat rows from
 * the scrolling window.
 */
function taskColumns(tableWidth: number): TableColumn<TaskRow>[] {
  const promptWidth = Math.max(tableWidth - TASK_FIXED_COLUMNS_WIDTH, MIN_PROMPT_WIDTH);
  return [
    { key: "time", header: "time", width: 5 },
    { key: "project", header: "project", width: 12 },
    { key: "work", header: "work", width: 7, align: "right" },
    { key: "cost", header: "cost", width: 6, align: "right" },
    { key: "prompt", header: "prompt", width: promptWidth },
  ];
}

function taskCell(row: TaskRow, key: string): string {
  switch (key) {
    case "time":
      return row.time;
    case "project":
      return row.project;
    case "work":
      return formatMinutes(row.workMs);
    case "cost":
      return formatCost(row.cost);
    case "prompt":
      return row.prompt;
    default:
      return "";
  }
}

/** Rows the detail panel's own chrome (top border line + the inner box's bottom border) takes outside its content rows. */
const DETAIL_CHROME_ROWS = 2;

/**
 * The `[ Task ]` detail panel body: fixed-count metadata lines (client,
 * project, hub task, wall/work/wait, cost, subagents — whichever apply)
 * plus the prompt, word-wrapped to the panel's own inner width
 * (`wrapText`, never reimplemented here). The panel's `height` is fixed by
 * the caller (derived from `mainHeight`, never grown by content — see the
 * layout-stability rule in AGENTS.md-equivalent project docs); when the
 * wrapped prompt would need more rows than are left after the metadata
 * lines, only as many prompt lines as fit are shown, followed by a single
 * `muted` `… N more lines` line instead of letting Ink's own overflow
 * clipping silently swallow the rest with no visible cue.
 */
function DetailPanel({ row, width, height }: { row: TaskRow | undefined; width: number; height: number }) {
  const theme = useTheme();

  if (row === undefined) {
    return (
      <Panel title="Task" width={width} height={height}>
        <Text dimColor>no task selected</Text>
      </Panel>
    );
  }

  const innerWidth = Math.max(width - 2, 1);
  const contentRows = Math.max(height - DETAIL_CHROME_ROWS, 0);

  const metaLines: { text: string; dim: boolean }[] = [];
  if (row.clientName !== undefined) metaLines.push({ text: `client   ${row.clientName}`, dim: true });
  if (row.projectName !== undefined) metaLines.push({ text: `project  ${row.projectName}`, dim: true });
  if (row.hubTaskTitle !== undefined) metaLines.push({ text: `task     ${row.hubTaskTitle}`, dim: true });
  metaLines.push({ text: `wall ${formatMinutes(row.wallMs)}   work ${formatMinutes(row.workMs)}   wait ${formatMinutes(row.waitingMs)}`, dim: false });
  metaLines.push({ text: `cost ${formatCost(row.cost)}${row.cacheHit !== undefined ? `   cache hit ${Math.round(row.cacheHit * 100)}%` : ""}`, dim: false });
  metaLines.push({ text: `subagents ${row.subagentCount}`, dim: false });

  const promptBudget = Math.max(contentRows - metaLines.length, 0);
  const wrappedPrompt = wrapText(row.fullPrompt, innerWidth);
  const truncated = wrappedPrompt.length > promptBudget;
  const visiblePromptLines = truncated ? wrappedPrompt.slice(0, Math.max(promptBudget - 1, 0)) : wrappedPrompt.slice(0, promptBudget);
  const hiddenCount = wrappedPrompt.length - visiblePromptLines.length;
  const showIndicator = truncated && promptBudget > 0;

  return (
    <Panel title="Task" width={width} height={height}>
      <Box flexDirection="column">
        {visiblePromptLines.map((line, index) => (
          <Text key={`prompt-${index}`}>{line}</Text>
        ))}
        {showIndicator && <Text color={theme.muted}>{`… ${hiddenCount} more lines`}</Text>}
        {metaLines.map((line, index) => (
          <Text key={`meta-${index}`} dimColor={line.dim}>
            {line.text}
          </Text>
        ))}
      </Box>
    </Panel>
  );
}

const KEY_HINTS = [
  { key: "↑↓", label: "select" },
  { key: "a", label: "today/all" },
  { key: "r", label: "refresh" },
  { key: "esc", label: "clear filter" },
  { key: "1-4", label: "screens" },
  { key: "q", label: "quit" },
];

/** Below this main-content width, the detail panel stacks under the table instead of beside it. */
const DETAIL_BREAKPOINT = 70;
/** Rows the `Panel` chrome (top border line + bottom border line) and the `Table`'s own header line take, outside its data rows. */
const TABLE_CHROME_ROWS = 3;

/**
 * The Tasks screen: a table of tasks (via `domain/tasks-model.ts`, never
 * reimplemented here) with a `[ Task ]` detail panel for the selected row.
 * `a` toggles today/all, `r` reloads, `↑↓` move the selection. When
 * `projectFilter` is set (via Today's `enter`), the table is restricted to
 * that project and `esc` clears it through `onClearFilter`. Never writes
 * anything to disk.
 */
export function TasksScreen({ load, roots, version, columns, rows, focused = true, projectFilter, onClearFilter }: TasksScreenProps) {
  const allRef = useRef(false);
  const [all, setAll] = useState(false);
  const [model, setModel] = useState<TasksModel>(() => load({ all: false }));
  const [selected, setSelected] = useState(0);

  const visibleRows = useMemo(
    () => (projectFilter !== undefined ? model.rows.filter((row) => row.project === projectFilter) : model.rows),
    [model.rows, projectFilter],
  );

  const maxRowsRef = useRef(0);

  useInput(
    (input, key) => {
      const lastIndex = Math.max(visibleRows.length - 1, 0);
      if (input === "a") {
        const nextAll = !allRef.current;
        allRef.current = nextAll;
        setAll(nextAll);
        setModel(load({ all: nextAll }));
        setSelected(0);
      } else if (input === "r") {
        setModel(load({ all: allRef.current }));
      } else if (key.downArrow) {
        setSelected((index) => Math.min(index + 1, lastIndex));
      } else if (key.upArrow) {
        setSelected((index) => Math.max(index - 1, 0));
      } else if (key.pageDown) {
        setSelected((index) => Math.min(index + Math.max(maxRowsRef.current, 1), lastIndex));
      } else if (key.pageUp) {
        setSelected((index) => Math.max(index - Math.max(maxRowsRef.current, 1), 0));
      } else if (key.home) {
        setSelected(0);
      } else if (key.end) {
        setSelected(lastIndex);
      } else if (key.escape) {
        onClearFilter?.();
      }
    },
    { isActive: focused },
  );

  return (
    <Layout
      columns={columns}
      rows={rows}
      headerLeft={`>_ kankaku ${version}`}
      headerRight={projectFilter !== undefined ? `filtered: ${projectFilter}` : undefined}
      sidebarItems={SCREENS}
      activeId="tasks"
      sidebarStats={[`tasks ${visibleRows.length}`, all ? "scope all" : "scope today"]}
      keyHints={hintsFor("tasks", focused ? "main" : "sidebar", KEY_HINTS)}
      focus={focused ? "main" : "sidebar"}
    >
      {({ mainWidth, mainHeight }) => {
        const wide = mainWidth >= DETAIL_BREAKPOINT;
        const tableWidth = wide ? Math.floor(mainWidth * 0.62) : mainWidth;
        const detailWidth = wide ? Math.max(mainWidth - tableWidth - 1, 1) : mainWidth;
        const selectedRow = visibleRows[Math.min(selected, Math.max(visibleRows.length - 1, 0))];

        // Stacked mode splits the height between the table and the detail panel below it, mirroring the width split used in wide mode.
        const tableHeight = wide ? mainHeight : Math.max(Math.floor(mainHeight * 0.62), TABLE_CHROME_ROWS + 1);
        const detailHeight = wide ? mainHeight : Math.max(mainHeight - tableHeight, DETAIL_CHROME_ROWS + 1);
        const maxRows = Math.max(tableHeight - TABLE_CHROME_ROWS, 1);
        maxRowsRef.current = maxRows;

        const table = (
          <Panel title="Tasks" width={tableWidth} height={wide ? mainHeight : tableHeight} active={focused}>
            <Table columns={taskColumns(tableWidth)} rows={visibleRows} rowKey={(row) => row.id} cell={taskCell} selectedIndex={selected} emptyText="no tasks" maxRows={maxRows} />
          </Panel>
        );
        const detail = <DetailPanel row={selectedRow} width={detailWidth} height={detailHeight} />;

        return wide ? (
          <Box flexDirection="row">
            {table}
            <Box width={1} />
            {detail}
          </Box>
        ) : (
          <Box flexDirection="column">
            {table}
            {detail}
          </Box>
        );
      }}
    </Layout>
  );
}
