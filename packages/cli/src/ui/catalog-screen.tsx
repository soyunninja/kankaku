import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatMinutes } from "../domain/today-model.ts";
import type { CatalogClientRow, CatalogModel, CatalogProjectRow } from "../domain/catalog-model.ts";
import { SCREENS, hintsFor } from "../domain/nav-model.ts";
import { Layout } from "./layout.tsx";
import { Panel } from "./components/panel.tsx";
import { Table } from "./components/table.tsx";
import type { TableColumn } from "./components/table.tsx";

export interface CatalogScreenProps {
  load: () => CatalogModel;
  refresh: () => Promise<CatalogModel>;
  roots: string[];
  version: string;
  columns?: number;
  rows?: number;
  /** Whether the main zone (this screen) has focus; when `false`, this screen's own list/action keys are inert. Defaults to `true` for a standalone render. */
  focused?: boolean;
}

const CLIENT_COLUMNS: TableColumn<CatalogClientRow>[] = [{ key: "name", header: "client", width: 20 }];

function clientCell(client: CatalogClientRow): string {
  return `${client.name} (${client.code})`;
}

const PROJECT_COLUMNS: TableColumn<CatalogProjectRow>[] = [
  { key: "name", header: "project", width: 18 },
  { key: "open", header: "open", width: 5, align: "right" },
  { key: "doing", header: "doing", width: 5, align: "right" },
];

function projectCell(project: CatalogProjectRow, key: string): string {
  switch (key) {
    case "name":
      return project.name;
    case "open":
      return String(project.openCount);
    case "doing":
      return String(project.doingCount);
    default:
      return "";
  }
}

const KEY_HINTS = [
  { key: "↑↓", label: "select" },
  { key: "r", label: "refresh" },
  { key: "1-4", label: "screens" },
  { key: "q", label: "quit" },
];

/** Below this main-content width, the Projects panel stacks under Clients instead of beside it. */
const DETAIL_BREAKPOINT = 70;
/** Rows a panel's own chrome (border + table header) takes outside its data rows. */
const TABLE_CHROME_ROWS = 3;

/**
 * The Catalog screen: a `[ Clients ]` list and, beside it, the selected
 * client's `[ Projects ]` with open/doing hub task counts — via
 * `adapters/hub.ts`'s `CachedCatalog`, never reimplemented here. `r`
 * refreshes against the hub; `↑↓` move the client selection. Without hub
 * credentials, or with no cache yet, shows a one-line note instead.
 */
export function CatalogScreen({ load, refresh, roots, version, columns, rows, focused = true }: CatalogScreenProps) {
  const [model, setModel] = useState<CatalogModel>(load);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState(0);
  const maxRowsRef = useRef(0);

  const clients = model.status === "ready" ? model.clients : [];

  useInput(
    (input, key) => {
      const lastIndex = Math.max(clients.length - 1, 0);
      if (input === "r" && !refreshing) {
        setRefreshing(true);
        void refresh().then((next) => {
          setModel(next);
          setRefreshing(false);
        });
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
      }
    },
    { isActive: focused },
  );

  if (model.status === "unavailable") {
    return (
      <Layout
        columns={columns}
        rows={rows}
        headerLeft={`>_ kankaku ${version}`}
        sidebarItems={SCREENS}
        activeId="catalog"
        sidebarStats={[`roots ${roots.length}`]}
        keyHints={hintsFor("catalog", focused ? "main" : "sidebar", KEY_HINTS)}
        focus={focused ? "main" : "sidebar"}
      >
        {() => <Text dimColor>{model.reason ?? "no catalog cached yet"}</Text>}
      </Layout>
    );
  }

  const selectedClient = clients[Math.min(selected, Math.max(clients.length - 1, 0))];
  const ageText = `fetched ${formatMinutes(model.ageMs)} ago${model.stale ? " (stale)" : ""}`;

  return (
    <Layout
      columns={columns}
      rows={rows}
      headerLeft={`>_ kankaku ${version}`}
      headerRight={refreshing ? "refreshing…" : undefined}
      sidebarItems={SCREENS}
      activeId="catalog"
      sidebarStats={[`clients ${clients.length}`]}
      keyHints={hintsFor("catalog", focused ? "main" : "sidebar", KEY_HINTS)}
      focus={focused ? "main" : "sidebar"}
    >
      {({ mainWidth, mainHeight }) => {
        const wide = mainWidth >= DETAIL_BREAKPOINT;
        const leftWidth = wide ? Math.floor(mainWidth * 0.4) : mainWidth;
        const rightWidth = wide ? Math.max(mainWidth - leftWidth - 1, 1) : mainWidth;

        // Stacked mode splits the height between Clients and Projects, mirroring the width split used in wide mode.
        const clientsHeight = wide ? mainHeight : Math.max(Math.floor(mainHeight * 0.4), TABLE_CHROME_ROWS + 1);
        const projectsHeight = wide ? mainHeight : Math.max(mainHeight - clientsHeight, TABLE_CHROME_ROWS + 1);
        const clientsMaxRows = Math.max(clientsHeight - TABLE_CHROME_ROWS, 1);
        const projectsMaxRows = Math.max(projectsHeight - TABLE_CHROME_ROWS, 1);
        maxRowsRef.current = clientsMaxRows;

        const clientsPanel = (
          <Panel title="Clients" headerRight={ageText} width={leftWidth} height={clientsHeight} active={focused}>
            <Table columns={CLIENT_COLUMNS} rows={clients} rowKey={(client) => client.id} cell={(client) => clientCell(client)} selectedIndex={selected} emptyText="no clients" maxRows={clientsMaxRows} />
          </Panel>
        );
        const projectsPanel = (
          <Panel title="Projects" width={rightWidth} height={projectsHeight}>
            <Table
              columns={PROJECT_COLUMNS}
              rows={selectedClient?.projects ?? []}
              rowKey={(project) => project.id}
              cell={projectCell}
              emptyText="no projects"
              maxRows={projectsMaxRows}
            />
          </Panel>
        );

        return wide ? (
          <Box flexDirection="row">
            {clientsPanel}
            <Box width={1} />
            {projectsPanel}
          </Box>
        ) : (
          <Box flexDirection="column">
            {clientsPanel}
            {projectsPanel}
          </Box>
        );
      }}
    </Layout>
  );
}
