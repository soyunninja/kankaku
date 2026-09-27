import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SyncRow } from "../domain/sync-model.ts";
import { SCREENS } from "../domain/nav-model.ts";
import { Layout } from "./layout.tsx";
import { Panel } from "./components/panel.tsx";
import { windowRows } from "../domain/list-window.ts";
import { useTheme } from "./theme.ts";

export interface SyncActionResult {
  ok: boolean;
  message: string;
}

export type SyncModel = { status: "unavailable"; reason: string } | { status: "ready"; rows: SyncRow[] };

export interface SyncScreenProps {
  load: () => SyncModel;
  syncOne: (project: SyncRow, options: { full: boolean }) => Promise<SyncActionResult>;
  syncAll: () => Promise<SyncActionResult[]>;
  roots: string[];
  version: string;
  columns?: number;
  rows?: number;
}

/** Fixed card width in the grid, including its border. */
const CARD_WIDTH = 32;
/** Estimated card height (border + up to 4 content lines: pending, synced/never, an error or result message, and a busy note), used to budget how many full rows of cards fit `mainHeight`. */
const CARD_HEIGHT_ESTIMATE = 6;

const KEY_HINTS = [
  { key: "↑↓", label: "select" },
  { key: "s", label: "sync" },
  { key: "f", label: "full sync" },
  { key: "S", label: "sync all" },
  { key: "1-4", label: "screens" },
  { key: "q", label: "quit" },
];

function Card({ row, active, message, busy, width }: { row: SyncRow; active: boolean; message: string | undefined; busy: boolean; width: number }) {
  const staleOutsidePart = row.staleOutsideWindow > 0 ? `  stale ${row.staleOutsideWindow}` : "";
  return (
    <Panel title={`${active ? "› " : "  "}${row.name}`} active={active} width={width}>
      <Text>{`pending ${row.pending}${staleOutsidePart}`}</Text>
      <Text dimColor>{row.syncedThrough !== undefined ? `synced through ${row.syncedThrough}` : "never synced"}</Text>
      {row.lastError !== undefined && <Text color="red">{`error: ${row.lastError.message}`}</Text>}
      {message !== undefined && <Text>{`→ ${message}`}</Text>}
      {busy && <Text dimColor>syncing…</Text>}
    </Panel>
  );
}

/**
 * The Sync screen: one `[ project ]` card per project, in a wrapping grid,
 * from `computeSyncStatus` (`domain/sync-model.ts`, never reimplemented
 * here). `↑↓` move the selection; `s` syncs the selected project, `f`
 * full-syncs it, `S` syncs every project — all through
 * `adapters/hub.ts#syncProject`. Each action's result shows inline in its
 * card while it runs and once it settles. Without hub credentials shows a
 * one-line note instead. Writes only through kankaku's own sync adapters.
 */
export function SyncScreen({ load, syncOne, syncAll, roots, version, columns, rows }: SyncScreenProps) {
  const theme = useTheme();
  const [model, setModel] = useState<SyncModel>(load);
  const [selected, setSelected] = useState(0);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const selectedRef = useRef(0);
  const maxVisibleRef = useRef(0);
  const startRef = useRef(0);

  const projectRows = model.status === "ready" ? model.rows : [];

  const runOne = (row: SyncRow, full: boolean) => {
    setBusy((prev) => new Set(prev).add(row.name));
    void syncOne(row, { full }).then((result) => {
      setMessages((prev) => ({ ...prev, [row.name]: result.message }));
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(row.name);
        return next;
      });
    });
  };

  useInput((input, key) => {
    if (model.status !== "ready") return;

    const lastIndex = Math.max(projectRows.length - 1, 0);
    if (key.downArrow) {
      selectedRef.current = Math.min(selectedRef.current + 1, lastIndex);
      setSelected(selectedRef.current);
    } else if (key.upArrow) {
      selectedRef.current = Math.max(selectedRef.current - 1, 0);
      setSelected(selectedRef.current);
    } else if (key.pageDown) {
      selectedRef.current = Math.min(selectedRef.current + Math.max(maxVisibleRef.current, 1), lastIndex);
      setSelected(selectedRef.current);
    } else if (key.pageUp) {
      selectedRef.current = Math.max(selectedRef.current - Math.max(maxVisibleRef.current, 1), 0);
      setSelected(selectedRef.current);
    } else if (key.home) {
      selectedRef.current = 0;
      setSelected(0);
    } else if (key.end) {
      selectedRef.current = lastIndex;
      setSelected(lastIndex);
    } else if (input === "s") {
      const row = projectRows[selectedRef.current];
      if (row) runOne(row, false);
    } else if (input === "f") {
      const row = projectRows[selectedRef.current];
      if (row) runOne(row, true);
    } else if (input === "S") {
      setBusy(new Set(projectRows.map((row) => row.name)));
      void syncAll().then((results) => {
        setMessages((prev) => {
          const next = { ...prev };
          results.forEach((result, index) => {
            const row = projectRows[index];
            if (row) next[row.name] = result.message;
          });
          return next;
        });
        setBusy(new Set());
      });
    }
  });

  if (model.status === "unavailable") {
    return (
      <Layout columns={columns} rows={rows} headerLeft={`>_ kankaku ${version}`} sidebarItems={SCREENS} activeId="sync" sidebarStats={[`roots ${roots.length}`]} keyHints={KEY_HINTS}>
        {() => <Text dimColor>{model.reason}</Text>}
      </Layout>
    );
  }

  return (
    <Layout
      columns={columns}
      rows={rows}
      headerLeft={`>_ kankaku ${version}`}
      sidebarItems={SCREENS}
      activeId="sync"
      sidebarStats={[`projects ${projectRows.length}`]}
      keyHints={KEY_HINTS}
    >
      {({ mainWidth, mainHeight }) => {
        if (projectRows.length === 0) return <Text dimColor>no projects</Text>;

        const cardsPerRow = Math.max(Math.floor(mainWidth / (CARD_WIDTH + 1)), 1);
        const visibleGridRows = Math.max(Math.floor(mainHeight / CARD_HEIGHT_ESTIMATE), 1);
        const maxVisible = cardsPerRow * visibleGridRows;
        maxVisibleRef.current = maxVisible;

        const window = windowRows(projectRows.length, selected, maxVisible, startRef.current);
        startRef.current = window.start;
        const visibleRows = projectRows.slice(window.start, window.end);

        return (
          <Box flexDirection="column">
            {window.hiddenAbove > 0 && <Text color={theme.muted}>{`↑ ${window.hiddenAbove} more`}</Text>}
            <Box flexDirection="row" flexWrap="wrap" width={mainWidth}>
              {visibleRows.map((row, index) => {
                const actualIndex = window.start + index;
                return (
                  <Box key={row.name} marginRight={1} marginBottom={1}>
                    <Card row={row} active={actualIndex === selected} message={messages[row.name]} busy={busy.has(row.name)} width={Math.min(CARD_WIDTH, mainWidth)} />
                  </Box>
                );
              })}
            </Box>
            {window.hiddenBelow > 0 && <Text color={theme.muted}>{`↓ ${window.hiddenBelow} more`}</Text>}
          </Box>
        );
      }}
    </Layout>
  );
}
