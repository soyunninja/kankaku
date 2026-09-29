import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatMinutes } from "../domain/today-model.ts";
import type { TaskRow, TasksModel } from "../domain/tasks-model.ts";
import { SCREENS, hintsFor } from "../domain/nav-model.ts";
import { wrapText } from "../domain/text-wrap.ts";
import { NOT_ON_HUB, describeAssignment, eligibleForBulk } from "../domain/reassign-model.ts";
import type { HubRowSnapshot, ReassignMode, ReassignTarget, RowOutcome } from "../domain/reassign-model.ts";
import { advance, back, finishApplying, jumpSelection, moveSelection, openPicker, pickerHints, pickerRowCount } from "../domain/reassign-picker.ts";
import type { PickerState } from "../domain/reassign-picker.ts";
import type { ReassignActions } from "../ports/reassign-actions.ts";
import { ReassignPanel, pickerMaxRows } from "./reassign-panel.tsx";
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
  /** The hub side of `a`/`A` (reassignment). Omitted in a standalone render: the keys then say reassignment is not available. */
  reassign?: ReassignActions;
  /** Called with `true` while the hub is queried or the picker is open, `false` otherwise, so the app shell keeps its own `esc`/`←`/`Tab`/`1`-`4` keys out of the way. */
  onModalChange?: (open: boolean) => void;
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
function DetailPanel({ row, hub, width, height }: { row: TaskRow | undefined; hub: string | undefined; width: number; height: number }) {
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
  if (hub !== undefined) metaLines.push({ text: `hub      ${hub}`, dim: true });
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
          <Text key={`meta-${index}`} dimColor={line.dim} wrap="truncate-end">
            {line.text}
          </Text>
        ))}
      </Box>
    </Panel>
  );
}

const KEY_HINTS = [
  { key: "↑↓", label: "select" },
  { key: "a", label: "reassign" },
  { key: "A", label: "bulk" },
  { key: "t", label: "today/all" },
  { key: "r", label: "refresh" },
  { key: "1-4", label: "screens" },
  { key: "q", label: "quit" },
];

/** With a project filter set, `esc` clears it; listed only then, so the footer stays on one line in narrower terminals. */
const FILTERED_KEY_HINTS = [...KEY_HINTS.slice(0, 5), { key: "esc", label: "clear filter" }, ...KEY_HINTS.slice(5)];

/** Below this main-content width, the detail panel stacks under the table instead of beside it. */
const DETAIL_BREAKPOINT = 70;
/** Rows the `Panel` chrome (top border line + bottom border line) and the `Table`'s own header line take, outside its data rows. */
const TABLE_CHROME_ROWS = 3;

/** Footer messages of the reassignment flow. */
const ASKING_HUB = "asking the hub…";
const REASSIGN_UNAVAILABLE = "reassignment is not available: no hub connection in this session";
const NOTHING_UNASSIGNED = "no unassigned tasks on the hub in this view";

function toTarget(row: TaskRow): ReassignTarget {
  return { taskId: row.id, label: row.prompt };
}

/**
 * The Tasks screen: a table of tasks (via `domain/tasks-model.ts`, never
 * reimplemented here) with a `[ Task ]` detail panel for the selected row.
 * `t` toggles today/all, `r` reloads, `↑↓` move the selection. When
 * `projectFilter` is set (via Today's `enter`), the table is restricted to
 * that project and `esc` clears it through `onClearFilter`.
 *
 * `a` reassigns the selected task on the hub and `A` every task of the
 * current view that is unassigned there: the screen asks the hub for the
 * rows involved (`reassign.prepare`, a progress message in the footer
 * meanwhile), then opens the picker (`domain/reassign-picker.ts`) as a
 * panel over the content zone. The picker is a modal flow: while it is
 * open (or the hub is being asked) every other key of the screen is inert.
 * Nothing is written to disk; the hub is written only by `reassign.apply`,
 * after the review step.
 */
export function TasksScreen({ load, roots, version, columns, rows, focused = true, projectFilter, onClearFilter, reassign, onModalChange }: TasksScreenProps) {
  const allRef = useRef(false);
  const [all, setAll] = useState(false);
  const [model, setModel] = useState<TasksModel>(() => load({ all: false }));
  const [selected, setSelected] = useState(0);
  const [picker, setPickerState] = useState<PickerState | undefined>(undefined);
  const pickerRef = useRef<PickerState | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const askingRef = useRef(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  /** The hub's assignment (by names) for the tasks asked about in this session, keyed by kankaku task id. */
  const [hubAssignments, setHubAssignments] = useState<Record<string, string>>({});

  const visibleRows = useMemo(
    () => (projectFilter !== undefined ? model.rows.filter((row) => row.project === projectFilter) : model.rows),
    [model.rows, projectFilter],
  );

  const maxRowsRef = useRef(0);
  const pickerRowsRef = useRef(1);

  const setPicker = (next: PickerState | undefined) => {
    pickerRef.current = next;
    setPickerState(next);
  };

  const modalOpen = asking || picker !== undefined;
  useEffect(() => {
    onModalChange?.(modalOpen);
  }, [modalOpen]);

  const rememberHubRows = (found: ReadonlyMap<string, HubRowSnapshot>, catalog: Parameters<typeof describeAssignment>[1]) => {
    setHubAssignments((current) => {
      const next = { ...current };
      for (const [taskId, hubRow] of found) next[taskId] = describeAssignment(hubRow, catalog);
      return next;
    });
  };

  const startReassign = (mode: ReassignMode) => {
    if (reassign === undefined) {
      setNote(REASSIGN_UNAVAILABLE);
      return;
    }
    const chosen = mode === "single" ? [visibleRows[Math.min(selected, Math.max(visibleRows.length - 1, 0))]] : visibleRows;
    const targets = chosen.filter((row): row is TaskRow => row !== undefined).map(toTarget);
    if (targets.length === 0) {
      setNote("no tasks to reassign");
      return;
    }

    askingRef.current = true;
    setAsking(true);
    setNote(ASKING_HUB);
    void reassign
      .prepare(targets.map((target) => target.taskId))
      .then((prepared) => {
        if (!prepared.ok) {
          setNote(prepared.message);
          return;
        }
        rememberHubRows(prepared.rows, prepared.catalog);
        if (mode === "single" && !prepared.rows.has(targets[0]!.taskId)) {
          setNote(NOT_ON_HUB);
          return;
        }
        if (mode === "bulk" && eligibleForBulk(targets, prepared.rows, prepared.catalog).length === 0) {
          setNote(NOTHING_UNASSIGNED);
          return;
        }
        setNote(undefined);
        setPicker(openPicker({ mode, catalog: prepared.catalog, targets, rows: prepared.rows }));
      })
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        askingRef.current = false;
        setAsking(false);
      });
  };

  const startApply = (state: PickerState) => {
    const plan = state.plan;
    if (reassign === undefined || plan === undefined || !plan.ok) return;
    const settle = (outcomes: RowOutcome[]) => {
      const current = pickerRef.current ?? state;
      setPicker(finishApplying(current, outcomes));
      setHubAssignments((assignments) => {
        const next = { ...assignments };
        for (const line of plan.plan.lines) {
          if (line.kind === "reassign" && outcomes.some((outcome) => outcome.taskId === line.taskId && outcome.status === "reassigned")) next[line.taskId] = line.to;
        }
        return next;
      });
    };
    void reassign.apply(plan.plan).then(settle, (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      settle(plan.plan.lines.filter((line) => line.kind === "reassign").map((line) => ({ taskId: line.taskId, status: "failed" as const, reason })));
    });
  };

  const handlePickerKey = (current: PickerState, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
    if (current.step === "applying") return;
    const page = Math.max(pickerRowsRef.current, 1);
    if (key.escape || key.leftArrow) {
      setPicker(back(current));
    } else if (key.return) {
      const next = advance(current);
      setPicker(next);
      if (next !== undefined && next.step === "applying" && current.step === "review") startApply(next);
    } else if (key.downArrow) {
      setPicker(moveSelection(current, 1));
    } else if (key.upArrow) {
      setPicker(moveSelection(current, -1));
    } else if (key.pageDown) {
      setPicker(moveSelection(current, page));
    } else if (key.pageUp) {
      setPicker(moveSelection(current, -page));
    } else if (key.home) {
      setPicker(jumpSelection(current, "first"));
    } else if (key.end) {
      setPicker(jumpSelection(current, "last"));
    }
  };

  useInput(
    (input, key) => {
      if (askingRef.current) return;
      setNote(undefined);
      const openPickerState = pickerRef.current;
      if (openPickerState !== undefined) {
        handlePickerKey(openPickerState, key);
        return;
      }

      const lastIndex = Math.max(visibleRows.length - 1, 0);
      if (input === "a") {
        startReassign("single");
      } else if (input === "A") {
        startReassign("bulk");
      } else if (input === "t") {
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
      keyHints={picker !== undefined ? pickerHints(picker) : hintsFor("tasks", focused ? "main" : "sidebar", projectFilter !== undefined ? FILTERED_KEY_HINTS : KEY_HINTS)}
      {...(note !== undefined ? { footerNote: note } : {})}
      focus={focused ? "main" : "sidebar"}
    >
      {({ mainWidth, mainHeight }) => {
        if (picker !== undefined) {
          pickerRowsRef.current = pickerMaxRows(mainHeight);
          return <ReassignPanel state={picker} width={mainWidth} height={mainHeight} />;
        }

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
        const detail = <DetailPanel row={selectedRow} hub={selectedRow !== undefined ? hubAssignments[selectedRow.id] : undefined} width={detailWidth} height={detailHeight} />;

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
