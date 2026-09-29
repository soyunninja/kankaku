import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatMinutes } from "../domain/today-model.ts";
import type { TodayRow } from "../domain/today-model.ts";
import type { DashboardHubCard, DashboardModel, DashboardProjectRow, DayPoint } from "../domain/dashboard-model.ts";
import { SCREENS, hintsFor } from "../domain/nav-model.ts";
import { formatQuickActionLines, quickActionsFor } from "../domain/quick-actions.ts";
import type { QuickActionKey, QuickActionState } from "../domain/quick-actions.ts";
import { Layout } from "./layout.tsx";
import { Panel } from "./components/panel.tsx";
import { Table } from "./components/table.tsx";
import type { TableColumn } from "./components/table.tsx";
import { Sparkline } from "./components/sparkline.tsx";
import { renderBar } from "./components/bar.tsx";
import { useTheme } from "./theme.ts";

/**
 * The Dashboard screen's Quick actions dependencies, supplied by
 * `cli.tsx` from `adapters/hub.ts`: `refreshCatalog` refreshes the full
 * catalog from the hub, `syncAll` syncs every discovered project
 * (`full: true` for a full resync), both resolving to an already-formatted
 * result message (reusing kankaku's own `formatCatalogRefreshLines`/
 * `formatSyncSummaryLines` — never reimplemented here). `hubAvailable`
 * mirrors the Hub card's own `status === "ready"`: when `false`, `c`/`s`/
 * `S` do nothing and the panel shows why instead.
 */
export interface DashboardActions {
  refreshCatalog: () => Promise<string>;
  syncAll: (options: { full: boolean }) => Promise<string>;
  hubAvailable: boolean;
  /** Only present when the configured hub is this machine's local install (`~/.kankaku/hub/hub.json`): `toggle` starts it if stopped, stops it if running, resolving to an already-formatted result message. Its presence alone drives the `h` quick action and the Hub card's extra local-hub line. */
  localHub?: { toggle: () => Promise<string> };
}

export interface DashboardScreenProps {
  load: () => DashboardModel;
  actions: DashboardActions;
  roots: string[];
  /** This app's own version, for the header bar (`>_ kankaku <version>`). */
  version: string;
  columns?: number;
  rows?: number;
  /** Whether the main zone (this screen) has focus; when `false`, this screen's own list/action keys are inert. Defaults to `true` for a standalone render. */
  focused?: boolean;
  /** `enter` on the selected project row: open it in Tasks, filtered. Omitted when the caller does not wire navigation (e.g. a standalone render). */
  onOpenProject?: (project: string) => void;
}

const KEY_HINTS = [
  { key: "↑↓", label: "move" },
  { key: "enter", label: "open" },
  { key: "r", label: "refresh" },
  { key: "1-4", label: "screens" },
  { key: "q", label: "quit" },
];

const HUB_UNAVAILABLE_REASON = "hub not configured (~/.kankaku/credentials.json)";

/** `HH:MM`, local time, from an ISO timestamp. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

/** The header bar's right-hand hub status, or `undefined` when the hub is not configured. */
function hubHeaderText(hub: DashboardHubCard): string | undefined {
  if (hub.status !== "ready") return undefined;
  const domain = hub.catalog?.url.replace(/^https?:\/\//, "");
  const domainPart = domain !== undefined ? `${domain} · ` : "";
  const syncedPart = hub.lastSyncAt !== undefined ? `synced ${formatTime(hub.lastSyncAt)}` : "no sync yet";
  return `hub ${hub.lastSyncOk ? "●" : "✕"} ${domainPart}${syncedPart}`;
}

function TodayPanel({ today, width, height }: { today: TodayRow; width: number; height: number }) {
  const cacheHitPart = today.cacheHit !== undefined ? `   cache hit ${Math.round(today.cacheHit * 100)}%` : "";
  return (
    <Panel title="Today" width={width} height={height}>
      <Text>{`work   ${formatMinutes(today.workMs)}`}</Text>
      <Text>{`wait   ${formatMinutes(today.waitingMs)}   cost  ${formatCost(today.cost)}`}</Text>
      <Text>{`tasks  ${today.tasks}${cacheHitPart}`}</Text>
    </Panel>
  );
}

function Last7DaysPanel({ points, width, height }: { points: DayPoint[]; width: number; height: number }) {
  return (
    <Panel title="Last 7 days" width={width} height={height}>
      <Text>
        {"work  "}
        <Sparkline values={points.map((point) => point.workMs)} />
        {"   cost  "}
        <Sparkline values={points.map((point) => point.cost)} />
      </Text>
      <Text dimColor>{points.map((point) => point.weekday).join(" ")}</Text>
    </Panel>
  );
}

/** Combined width of every fixed-width column but `project`, plus their separating spaces, the row's own `› `/`  ` marker prefix, and the panel's own left/right border columns. */
const PROJECT_FIXED_COLUMNS_WIDTH = 8 + 1 + 7 + 1 + 12 + 1 + 2 + 2;
/** Floor for the `project` column so a very narrow table still shows a sliver of the name instead of collapsing to nothing. */
const MIN_PROJECT_NAME_WIDTH = 4;

/**
 * `work`/`cost`/`share` are fixed-width; `project` absorbs whatever width
 * is left in `panelWidth` (the panel's own outer width, including its
 * border columns) so the row's total text never exceeds the panel's
 * actual content width — which would otherwise wrap inside the
 * fixed-height, `overflow: hidden` panel and corrupt the scrolling
 * window (see the matching fix in `tasks-screen.tsx`).
 */
function projectColumns(panelWidth: number): TableColumn<DashboardProjectRow>[] {
  const nameWidth = Math.max(panelWidth - PROJECT_FIXED_COLUMNS_WIDTH, MIN_PROJECT_NAME_WIDTH);
  return [
    { key: "name", header: "project", width: nameWidth },
    { key: "work", header: "work", width: 8, align: "right" },
    { key: "cost", header: "cost", width: 7, align: "right" },
    { key: "share", header: "share", width: 12 },
  ];
}

function projectCell(row: DashboardProjectRow, key: string): string {
  switch (key) {
    case "name":
      return row.name;
    case "work":
      return formatMinutes(row.workMs);
    case "cost":
      return formatCost(row.cost);
    case "share":
      return renderBar(row.share, 1, 10);
    default:
      return "";
  }
}

function ProjectsPanel({ rows, selectedIndex, width, height, maxRows, active }: { rows: DashboardProjectRow[]; selectedIndex: number; width: number; height: number; maxRows: number; active: boolean }) {
  return (
    <Panel title="Projects" width={width} height={height} active={active}>
      <Table columns={projectColumns(width)} rows={rows} rowKey={(row) => row.name} cell={projectCell} selectedIndex={selectedIndex} emptyText="no work recorded today" maxRows={maxRows} />
    </Panel>
  );
}

function HubPanel({ hub, width, height }: { hub: DashboardHubCard; width: number; height: number }) {
  return (
    <Panel title="Hub" width={width} height={height}>
      {hub.status === "unavailable" ? (
        <Text dimColor>hub not configured</Text>
      ) : (
        <Box flexDirection="column">
          <Text>{`pending ${hub.pending} · stale ${hub.staleOutsideWindow}`}</Text>
          <Text>{`last sync ${hub.lastSyncOk ? "ok" : "error"}${hub.lastSyncAt !== undefined ? ` ${formatTime(hub.lastSyncAt)}` : ""}`}</Text>
          {hub.catalog !== undefined && <Text>{`catalog ${hub.catalog.clientCount} clients · ${hub.catalog.projectCount} projects`}</Text>}
          {hub.localHub !== undefined && <Text>{`local hub · ${hub.localHub}`}</Text>}
        </Box>
      )}
    </Panel>
  );
}

/** Rows the Quick actions panel's own chrome takes outside its content: 1 top border + 1 bottom border. */
const QUICK_ACTIONS_CHROME_ROWS = 2;

/** Rows the Quick actions panel takes: its chrome, one line per shown action (`QUICK_ACTIONS`, plus the local-hub action when `showLocalHub`), plus one status line. */
function quickActionsPanelRows(showLocalHub: boolean): number {
  return QUICK_ACTIONS_CHROME_ROWS + quickActionsFor(showLocalHub).length + 1;
}

/**
 * The `[ Quick actions ]` panel: `QUICK_ACTIONS` (plus the local-hub `h`
 * action when `showLocalHub`) listed one per line (key in the accent
 * colour, label muted — the same convention as the footer `KeyHints`),
 * followed by one status line from `domain/quick-actions.ts#formatQuickActionLines`
 * (always exactly one line, so this panel's height never changes with the
 * message).
 */
function QuickActionsPanel({ state, width, height, active, showLocalHub }: { state: QuickActionState; width: number; height: number; active: boolean; showLocalHub: boolean }) {
  const theme = useTheme();
  const [statusLine] = formatQuickActionLines(Math.max(width - 2, 1), state);
  return (
    <Panel title="Quick actions" width={width} height={height} active={active}>
      {quickActionsFor(showLocalHub).map((action) => (
        <Text key={action.key}>
          <Text color={theme.accent}>{action.key}</Text>
          <Text color={theme.muted}>{`  ${action.label}`}</Text>
        </Text>
      ))}
      <Text dimColor={state.status === "busy" || state.status === "unavailable"} color={state.status === "done" && statusLine.startsWith("error:") ? theme.error : undefined}>
        {statusLine}
      </Text>
    </Panel>
  );
}

/** Below this main-content width, the two-column grid collapses to one column, stacking every panel. */
const GRID_BREAKPOINT = 70;
/** Rows the Today card's panel takes: 1 top border + 3 content lines + 1 bottom border. */
const TODAY_PANEL_ROWS = 5;
/** Rows the Last 7 days panel takes: 1 top border + 2 content lines + 1 bottom border. */
const LAST7_PANEL_ROWS = 4;
/** Rows the Hub panel takes at most: 1 top border + up to 3 content lines + 1 bottom border; one more when `showLocalHub` (its extra `local hub · running|stopped` line). */
function hubPanelRows(showLocalHub: boolean): number {
  return showLocalHub ? 6 : 5;
}
/** Rows the Projects panel's own chrome (border + table header) takes outside its data rows. */
const TABLE_CHROME_ROWS = 3;

/** How many data rows the Projects table can show for a given `mainHeight`, depending on whether the grid is two columns (`grid`) or stacked to one (`stacked`). */
function projectsMaxRows(mainHeight: number, layout: "grid" | "stacked", showLocalHub: boolean): number {
  const fixedRows = layout === "grid" ? TODAY_PANEL_ROWS : TODAY_PANEL_ROWS + LAST7_PANEL_ROWS + hubPanelRows(showLocalHub) + quickActionsPanelRows(showLocalHub);
  return Math.max(mainHeight - fixedRows - TABLE_CHROME_ROWS, 1);
}

/**
 * The Projects panel's own explicit height for a given `mainHeight`/`layout`
 * — `TABLE_CHROME_ROWS` plus however many data rows `projectsMaxRows`
 * allows, so the panel itself never grows past what its own table renders
 * (see the layout-stability rule this screen's panels all follow).
 */
function projectsPanelHeight(mainHeight: number, layout: "grid" | "stacked", showLocalHub: boolean): number {
  return TABLE_CHROME_ROWS + projectsMaxRows(mainHeight, layout, showLocalHub);
}

function DashboardGrid({
  model,
  selectedIndex,
  mainWidth,
  mainHeight,
  focused,
  actionState,
  showLocalHub,
}: {
  model: DashboardModel;
  selectedIndex: number;
  mainWidth: number;
  mainHeight: number;
  focused: boolean;
  actionState: QuickActionState;
  showLocalHub: boolean;
}) {
  if (mainWidth < GRID_BREAKPOINT) {
    return (
      <Box flexDirection="column">
        <TodayPanel today={model.today} width={mainWidth} height={TODAY_PANEL_ROWS} />
        <Last7DaysPanel points={model.last7Days} width={mainWidth} height={LAST7_PANEL_ROWS} />
        <ProjectsPanel
          rows={model.projects}
          selectedIndex={selectedIndex}
          width={mainWidth}
          height={projectsPanelHeight(mainHeight, "stacked", showLocalHub)}
          maxRows={projectsMaxRows(mainHeight, "stacked", showLocalHub)}
          active={focused}
        />
        <QuickActionsPanel state={actionState} width={mainWidth} height={quickActionsPanelRows(showLocalHub)} active={false} showLocalHub={showLocalHub} />
        <HubPanel hub={model.hub} width={mainWidth} height={hubPanelRows(showLocalHub)} />
      </Box>
    );
  }

  const leftWidth = Math.floor(mainWidth * 0.55);
  const rightWidth = Math.max(mainWidth - leftWidth - 1, 1);
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={leftWidth}>
        <TodayPanel today={model.today} width={leftWidth} height={TODAY_PANEL_ROWS} />
        <ProjectsPanel
          rows={model.projects}
          selectedIndex={selectedIndex}
          width={leftWidth}
          height={projectsPanelHeight(mainHeight, "grid", showLocalHub)}
          maxRows={projectsMaxRows(mainHeight, "grid", showLocalHub)}
          active={focused}
        />
      </Box>
      <Box width={1} />
      <Box flexDirection="column" width={rightWidth}>
        <Last7DaysPanel points={model.last7Days} width={rightWidth} height={LAST7_PANEL_ROWS} />
        <HubPanel hub={model.hub} width={rightWidth} height={hubPanelRows(showLocalHub)} />
        <QuickActionsPanel state={actionState} width={rightWidth} height={quickActionsPanelRows(showLocalHub)} active={false} showLocalHub={showLocalHub} />
      </Box>
    </Box>
  );
}

/** The Quick actions panel's initial state: idle when the hub is configured, `unavailable` (with its reason) otherwise. */
function initialActionState(hubAvailable: boolean): QuickActionState {
  return hubAvailable ? { status: "idle" } : { status: "unavailable", reason: HUB_UNAVAILABLE_REASON };
}

/**
 * The Dashboard screen: a Today card (work/wait/cost/tasks/cache hit), a
 * Last 7 days card (work and cost sparklines with weekday labels), a
 * Projects table (work, cost and a share bar per project), a Hub card
 * (pending/stale, last sync time, catalog summary) and a Quick actions
 * panel (`c` refresh the catalog, `s` sync every project, `S` full-sync
 * every project, `r` reload) inside the shared header/sidebar/footer
 * frame. `r` reloads through `load`; `↑↓` move the Projects selection;
 * `enter` opens the selected project in Tasks via `onOpenProject`. `c`/
 * `s`/`S` run through `actions` (never reimplementing kankaku's own
 * catalog/sync adapters); only one quick action runs at a time, and the
 * dashboard model reloads once it settles so the Hub card and Projects
 * table reflect the new state.
 */
export function DashboardScreen({ load, actions, roots, version, columns, rows, focused = true, onOpenProject }: DashboardScreenProps) {
  const [model, setModel] = useState<DashboardModel>(load);
  const [selected, setSelected] = useState(0);
  const [actionState, setActionState] = useState<QuickActionState>(() => initialActionState(actions.hubAvailable));
  const maxRowsRef = useRef(0);
  const busyRef = useRef(false);
  const showLocalHub = actions.localHub !== undefined;

  const runQuickAction = (key: QuickActionKey) => {
    if (busyRef.current) return;

    if (key === "r") {
      setModel(load());
      return;
    }

    if (key === "h") {
      if (!actions.localHub) return;
      busyRef.current = true;
      setActionState({ status: "busy", key });
      actions.localHub
        .toggle()
        .then((message) => {
          setActionState({ status: "done", key, message });
          setModel(load());
        })
        .catch((error: unknown) => {
          setActionState({ status: "done", key, message: `error: ${error instanceof Error ? error.message : String(error)}` });
        })
        .finally(() => {
          busyRef.current = false;
        });
      return;
    }

    if (!actions.hubAvailable) return;

    busyRef.current = true;
    setActionState({ status: "busy", key });
    const run = key === "c" ? actions.refreshCatalog() : actions.syncAll({ full: key === "S" });
    run
      .then((message) => {
        setActionState({ status: "done", key, message });
        setModel(load());
      })
      .catch((error: unknown) => {
        setActionState({ status: "done", key, message: `error: ${error instanceof Error ? error.message : String(error)}` });
      })
      .finally(() => {
        busyRef.current = false;
      });
  };

  useInput(
    (input, key) => {
      const lastIndex = Math.max(model.projects.length - 1, 0);
      if (input === "c" || input === "s" || input === "S" || input === "r" || input === "h") {
        runQuickAction(input as QuickActionKey);
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
      } else if (key.return) {
        const project = model.projects[selected];
        if (project) onOpenProject?.(project.name);
      }
    },
    { isActive: focused },
  );

  return (
    <Layout
      columns={columns}
      rows={rows}
      headerLeft={`>_ kankaku ${version}`}
      headerRight={hubHeaderText(model.hub)}
      sidebarItems={SCREENS}
      activeId="dashboard"
      sidebarStats={[`roots ${roots.length}`, `projects ${model.projects.length}`]}
      keyHints={hintsFor("dashboard", focused ? "main" : "sidebar", KEY_HINTS)}
      focus={focused ? "main" : "sidebar"}
    >
      {({ mainWidth, mainHeight }) => {
        maxRowsRef.current = projectsMaxRows(mainHeight, mainWidth < GRID_BREAKPOINT ? "stacked" : "grid", showLocalHub);
        return (
          <DashboardGrid model={model} selectedIndex={selected} mainWidth={mainWidth} mainHeight={mainHeight} focused={focused} actionState={actionState} showLocalHub={showLocalHub} />
        );
      }}
    </Layout>
  );
}
