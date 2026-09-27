import type { SyncStatusSnapshot } from "kankaku/hub";
import type { ProjectRef } from "../ports/project-source.ts";

export interface SyncRow {
  name: string;
  dir: string;
  pending: number;
  staleOutsideWindow: number;
  syncedThrough?: string;
  lastError?: { message: string; at: string };
}

export interface ProjectSyncStatus {
  project: ProjectRef;
  status: SyncStatusSnapshot;
}

/**
 * Build one {@link SyncRow} per project from its own
 * {@link SyncStatusSnapshot} (`kankaku/hub`'s `computeSyncStatus`, never
 * reimplemented here), sorted by project name.
 */
export function buildSyncRows(entries: ProjectSyncStatus[]): SyncRow[] {
  return entries
    .map(({ project, status }) => ({
      name: project.name,
      dir: project.dir,
      pending: status.pending,
      staleOutsideWindow: status.staleOutsideWindow,
      ...(status.state?.syncedThrough !== undefined ? { syncedThrough: status.state.syncedThrough } : {}),
      ...(status.state?.lastError !== undefined ? { lastError: status.state.lastError } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
