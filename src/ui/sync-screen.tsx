import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SyncRow } from "../domain/sync-model.ts";
import { SCREENS } from "../domain/nav-model.ts";
import { Layout } from "./layout.tsx";
import { Panel } from "./components/panel.tsx";

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
  const [model, setModel] = useState<SyncModel>(load);
  const [selected, setSelected] = useState(0);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const selectedRef = useRef(0);

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

    if (key.downArrow) {
      selectedRef.current = Math.min(selectedRef.current + 1, Math.max(projectRows.length - 1, 0));
      setSelected(selectedRef.current);
    } else if (key.upArrow) {
      selectedRef.current = Math.max(selectedRef.current - 1, 0);
      setSelected(selectedRef.current);
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
      {({ mainWidth }) =>
        projectRows.length === 0 ? (
          <Text dimColor>no projects</Text>
        ) : (
          <Box flexDirection="row" flexWrap="wrap" width={mainWidth}>
            {projectRows.map((row, index) => (
              <Box key={row.name} marginRight={1} marginBottom={1}>
                <Card row={row} active={index === selected} message={messages[row.name]} busy={busy.has(row.name)} width={Math.min(CARD_WIDTH, mainWidth)} />
              </Box>
            ))}
          </Box>
        )
      }
    </Layout>
  );
}
