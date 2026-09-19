import type { Client, Project } from "../domain/work-target.ts";

/** A cached read of the hub's clients/projects, plus when and against which hub URL it was fetched. */
export interface CatalogSnapshot {
  fetchedAt: number;
  url: string;
  clients: Client[];
  projects: Project[];
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
  /** Fetch a fresh snapshot, cache it, and return it. Never throws; resolves `undefined` on failure. */
  refresh(): Promise<CatalogSnapshot | undefined>;
}
