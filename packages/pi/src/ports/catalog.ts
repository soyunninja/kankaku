import type { Client, HubTask, Project } from "../domain/work-target.ts";

/** A cached read of the hub's clients/projects/tasks, plus when and against which hub URL it was fetched. */
export interface CatalogSnapshot {
  fetchedAt: number;
  url: string;
  clients: Client[];
  projects: Project[];
  /** Optional because a cache written by an older build (before hub task linking) never had this field; a missing value reads as "no tasks known yet." */
  tasks?: HubTask[];
}

/**
 * Read-only access to the hub catalog (clients/projects). `read()` is a
 * synchronous, cheap access to the last known snapshot so session start
 * never blocks on it; `refresh()` is the async network path. See
 * `adapters/cached-catalog.ts` for the disk-backed implementation.
 */
export interface Catalog {
  /** The last known snapshot, or `undefined` when none has ever been fetched or cached. */
  read(): CatalogSnapshot | undefined;
  /** `true` when there is no snapshot, or the cached one is older than the configured TTL. */
  isStale(): boolean;
  /**
   * Fetch a fresh snapshot, cache it, and return it. Never throws; resolves
   * `undefined` on failure. `signal`, when given, is composed with each
   * underlying request's own per-request timeout (see
   * `adapters/pocketbase-client.ts`) so a caller can bound the whole fetch
   * (auth, pagination, retries) with one overall deadline; an abort is
   * just another failure mode and also resolves `undefined`.
   */
  refresh(signal?: AbortSignal): Promise<CatalogSnapshot | undefined>;
}
