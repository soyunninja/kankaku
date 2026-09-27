import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatMinutes } from "../domain/today-model.ts";
import type { TodayRow } from "../domain/today-model.ts";
import type { DashboardHubCard, DashboardModel, DashboardProjectRow, DayPoint } from "../domain/dashboard-model.ts";
import { SCREENS, hintsFor } from "../domain/nav-model.ts";
import { Layout } from "./layout.tsx";
import { Panel } from "./components/panel.tsx";
import { Table } from "./components/table.tsx";
import type { TableColumn } from "./components/table.tsx";
import { Sparkline } from "./components/sparkline.tsx";
import { renderBar } from "./components/bar.tsx";

export interface TodayScreenProps {
  load: () => DashboardModel;
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

function TodayPanel({ today, width }: { today: TodayRow; width: number }) {
  const cacheHitPart = today.cacheHit !== undefined ? `   cache hit ${Math.round(today.cacheHit * 100)}%` : "";
  return (
    <Panel title="Today" width={width}>
      <Text>{`work   ${formatMinutes(today.workMs)}`}</Text>
      <Text>{`wait   ${formatMinutes(today.waitingMs)}   cost  ${formatCost(today.cost)}`}</Text>
      <Text>{`tasks  ${today.tasks}${cacheHitPart}`}</Text>
    </Panel>
  );
}

function Last7DaysPanel({ points, width }: { points: DayPoint[]; width: number }) {
  return (
    <Panel title="Last 7 days" width={width}>
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

function ProjectsPanel({ rows, selectedIndex, width, maxRows, active }: { rows: DashboardProjectRow[]; selectedIndex: number; width: number; maxRows: number; active: boolean }) {
  return (
    <Panel title="Projects" width={width} active={active}>
      <Table columns={projectColumns(width)} rows={rows} rowKey={(row) => row.name} cell={projectCell} selectedIndex={selectedIndex} emptyText="no work recorded today" maxRows={maxRows} />
    </Panel>
  );
}

function HubPanel({ hub, width }: { hub: DashboardHubCard; width: number }) {
  return (
    <Panel title="Hub" width={width}>
      {hub.status === "unavailable" ? (
        <Text dimColor>hub not configured</Text>
      ) : (
        <Box flexDirection="column">
          <Text>{`pending ${hub.pending} · stale ${hub.staleOutsideWindow}`}</Text>
          <Text>{`last sync ${hub.lastSyncOk ? "ok" : "error"}${hub.lastSyncAt !== undefined ? ` ${formatTime(hub.lastSyncAt)}` : ""}`}</Text>
          {hub.catalog !== undefined && <Text>{`catalog ${hub.catalog.clientCount} clients · ${hub.catalog.projectCount} projects`}</Text>}
        </Box>
      )}
    </Panel>
  );
}

/** Below this main-content width, the two-column grid collapses to one column, stacking every panel. */
const GRID_BREAKPOINT = 70;
/** Rows the Today card's panel takes: 1 top border + 3 content lines + 1 bottom border. */
const TODAY_PANEL_ROWS = 5;
/** Rows the Last 7 days panel takes: 1 top border + 2 content lines + 1 bottom border. */
const LAST7_PANEL_ROWS = 4;
/** Rows the Hub panel takes at most: 1 top border + up to 3 content lines + 1 bottom border. */
const HUB_PANEL_ROWS = 5;
/** Rows the Projects panel's own chrome (border + table header) takes outside its data rows. */
const TABLE_CHROME_ROWS = 3;

/** How many data rows the Projects table can show for a given `mainHeight`, depending on whether the grid is two columns (`grid`) or stacked to one (`stacked`). */
function projectsMaxRows(mainHeight: number, layout: "grid" | "stacked"): number {
  const fixedRows = layout === "grid" ? TODAY_PANEL_ROWS : TODAY_PANEL_ROWS + LAST7_PANEL_ROWS + HUB_PANEL_ROWS;
  return Math.max(mainHeight - fixedRows - TABLE_CHROME_ROWS, 1);
}

function DashboardGrid({
  model,
  selectedIndex,
  mainWidth,
  mainHeight,
  focused,
}: {
  model: DashboardModel;
  selectedIndex: number;
  mainWidth: number;
  mainHeight: number;
  focused: boolean;
}) {
  if (mainWidth < GRID_BREAKPOINT) {
    return (
      <Box flexDirection="column">
        <TodayPanel today={model.today} width={mainWidth} />
        <Last7DaysPanel points={model.last7Days} width={mainWidth} />
        <ProjectsPanel rows={model.projects} selectedIndex={selectedIndex} width={mainWidth} maxRows={projectsMaxRows(mainHeight, "stacked")} active={focused} />
        <HubPanel hub={model.hub} width={mainWidth} />
      </Box>
    );
  }

  const leftWidth = Math.floor(mainWidth * 0.55);
  const rightWidth = Math.max(mainWidth - leftWidth - 1, 1);
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={leftWidth}>
        <TodayPanel today={model.today} width={leftWidth} />
        <ProjectsPanel rows={model.projects} selectedIndex={selectedIndex} width={leftWidth} maxRows={projectsMaxRows(mainHeight, "grid")} active={focused} />
      </Box>
      <Box width={1} />
      <Box flexDirection="column" width={rightWidth}>
        <Last7DaysPanel points={model.last7Days} width={rightWidth} />
        <HubPanel hub={model.hub} width={rightWidth} />
      </Box>
    </Box>
  );
}

/**
 * The Today screen: a dashboard (Today card, Last 7 days sparklines,
 * Projects table with share bars, Hub card) inside the shared
 * header/sidebar/footer frame. `r` reloads through `load`; `↑↓` move the
 * Projects selection; `enter` opens the selected project in Tasks via
 * `onOpenProject`. Never writes anything to disk.
 */
export function TodayScreen({ load, roots, version, columns, rows, focused = true, onOpenProject }: TodayScreenProps) {
  const [model, setModel] = useState<DashboardModel>(load);
  const [selected, setSelected] = useState(0);
  const maxRowsRef = useRef(0);

  useInput(
    (input, key) => {
      const lastIndex = Math.max(model.projects.length - 1, 0);
      if (input === "r") {
        setModel(load());
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
      activeId="today"
      sidebarStats={[`roots ${roots.length}`, `projects ${model.projects.length}`]}
      keyHints={hintsFor("today", focused ? "main" : "sidebar", KEY_HINTS)}
      focus={focused ? "main" : "sidebar"}
    >
      {({ mainWidth, mainHeight }) => {
        maxRowsRef.current = projectsMaxRows(mainHeight, mainWidth < GRID_BREAKPOINT ? "stacked" : "grid");
        return <DashboardGrid model={model} selectedIndex={selected} mainWidth={mainWidth} mainHeight={mainHeight} focused={focused} />;
      }}
    </Layout>
  );
}
