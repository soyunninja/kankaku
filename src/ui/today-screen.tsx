import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatMinutes } from "../domain/today-model.ts";
import type { TodayRow } from "../domain/today-model.ts";
import type { DashboardHubCard, DashboardModel, DashboardProjectRow, DayPoint } from "../domain/dashboard-model.ts";
import { SCREENS } from "../domain/nav-model.ts";
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

const PROJECT_COLUMNS: TableColumn<DashboardProjectRow>[] = [
  { key: "name", header: "project", width: 14 },
  { key: "work", header: "work", width: 8, align: "right" },
  { key: "cost", header: "cost", width: 7, align: "right" },
  { key: "share", header: "share", width: 12 },
];

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

function ProjectsPanel({ rows, selectedIndex, width }: { rows: DashboardProjectRow[]; selectedIndex: number; width: number }) {
  return (
    <Panel title="Projects" width={width}>
      <Table columns={PROJECT_COLUMNS} rows={rows} rowKey={(row) => row.name} cell={projectCell} selectedIndex={selectedIndex} emptyText="no work recorded today" />
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

function DashboardGrid({ model, selectedIndex, mainWidth }: { model: DashboardModel; selectedIndex: number; mainWidth: number }) {
  if (mainWidth < GRID_BREAKPOINT) {
    return (
      <Box flexDirection="column">
        <TodayPanel today={model.today} width={mainWidth} />
        <Last7DaysPanel points={model.last7Days} width={mainWidth} />
        <ProjectsPanel rows={model.projects} selectedIndex={selectedIndex} width={mainWidth} />
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
        <ProjectsPanel rows={model.projects} selectedIndex={selectedIndex} width={leftWidth} />
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
export function TodayScreen({ load, roots, version, columns, rows, onOpenProject }: TodayScreenProps) {
  const [model, setModel] = useState<DashboardModel>(load);
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (input === "r") {
      setModel(load());
    } else if (key.downArrow) {
      setSelected((index) => Math.min(index + 1, Math.max(model.projects.length - 1, 0)));
    } else if (key.upArrow) {
      setSelected((index) => Math.max(index - 1, 0));
    } else if (key.return) {
      const project = model.projects[selected];
      if (project) onOpenProject?.(project.name);
    }
  });

  return (
    <Layout
      columns={columns}
      rows={rows}
      headerLeft={`>_ kankaku ${version}`}
      headerRight={hubHeaderText(model.hub)}
      sidebarItems={SCREENS}
      activeId="today"
      sidebarStats={[`roots ${roots.length}`, `projects ${model.projects.length}`]}
      keyHints={KEY_HINTS}
    >
      {({ mainWidth }) => <DashboardGrid model={model} selectedIndex={selected} mainWidth={mainWidth} />}
    </Layout>
  );
}
