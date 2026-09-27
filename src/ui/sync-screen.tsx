import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SyncRow } from "../domain/sync-model.ts";

export interface SyncActionResult {
  ok: boolean;
  message: string;
}

export type SyncModel = { status: "unavailable"; reason: string } | { status: "ready"; rows: SyncRow[] };

export interface SyncScreenProps {
  load: () => SyncModel;
  syncOne: (project: SyncRow, options: { full: boolean }) => Promise<SyncActionResult>;
  syncAll: () => Promise<SyncActionResult[]>;
}

function formatRow(row: SyncRow, message: string | undefined, busy: boolean): string {
  const staleOutsidePart = row.staleOutsideWindow > 0 ? `  stale-outside-window ${row.staleOutsideWindow}` : "";
  const syncedThroughPart = row.syncedThrough ? `  synced through ${row.syncedThrough}` : "  never synced";
  const errorPart = row.lastError ? `  last error: ${row.lastError.message}` : "";
  const messagePart = message ? `  → ${message}` : "";
  const busyPart = busy ? "  (syncing…)" : "";
  return `${row.name}  pending ${row.pending}${staleOutsidePart}${syncedThroughPart}${errorPart}${messagePart}${busyPart}`;
}

/**
 * The Sync screen: one row per project from `computeSyncStatus`
 * (`domain/sync-model.ts`, never reimplemented here). `↑↓` move the
 * selection; `s` syncs the selected project, `f` full-syncs it, `S` syncs
 * every project — all through `adapters/hub.ts#syncProject`, mirroring
 * kankaku-claude's `syncConfigured`. Without hub credentials shows a
 * one-line note instead. Writes only through kankaku's own sync adapters.
 */
export function SyncScreen({ load, syncOne, syncAll }: SyncScreenProps) {
  const [model, setModel] = useState<SyncModel>(load);
  const [selected, setSelected] = useState(0);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const selectedRef = useRef(0);

  const rows = model.status === "ready" ? model.rows : [];

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
      selectedRef.current = Math.min(selectedRef.current + 1, Math.max(rows.length - 1, 0));
      setSelected(selectedRef.current);
    } else if (key.upArrow) {
      selectedRef.current = Math.max(selectedRef.current - 1, 0);
      setSelected(selectedRef.current);
    } else if (input === "s") {
      const row = rows[selectedRef.current];
      if (row) runOne(row, false);
    } else if (input === "f") {
      const row = rows[selectedRef.current];
      if (row) runOne(row, true);
    } else if (input === "S") {
      setBusy(new Set(rows.map((row) => row.name)));
      void syncAll().then((results) => {
        setMessages((prev) => {
          const next = { ...prev };
          results.forEach((result, index) => {
            const row = rows[index];
            if (row) next[row.name] = result.message;
          });
          return next;
        });
        setBusy(new Set());
      });
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{">_ kankaku · Sync"}</Text>
      {model.status === "unavailable" ? (
        <Text>{model.reason}</Text>
      ) : rows.length === 0 ? (
        <Text>no projects</Text>
      ) : (
        <Box flexDirection="column">
          {rows.map((row, index) => (
            <Text key={row.name}>
              {`${index === selected ? "› " : "  "}${formatRow(row, messages[row.name], busy.has(row.name))}`}
            </Text>
          ))}
        </Box>
      )}
      <Text dimColor>s sync · f full sync · S sync all · ↑↓ select</Text>
    </Box>
  );
}
