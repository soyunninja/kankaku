import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Client, Project } from "../domain/work-target.ts";
import type { Clock } from "../ports/clock.ts";
import type { Catalog, CatalogSnapshot } from "../ports/catalog.ts";

/** Six hours in milliseconds — clients and projects change rarely. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

function isClientArray(value: unknown): value is Client[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" && typeof (item as Client).id === "string");
}

function isProjectArray(value: unknown): value is Project[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" && typeof (item as Project).id === "string");
}

function isCatalogSnapshot(value: unknown): value is CatalogSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["fetchedAt"] === "number" &&
    typeof record["url"] === "string" &&
    isClientArray(record["clients"]) &&
    isProjectArray(record["projects"])
  );
}

export interface CachedCatalogDeps {
  /** Absolute path to the cache file, e.g. `~/.kankaku/catalog.json`. */
  filePath: string;
  /** The configured hub URL; a cache written for a different URL is ignored. */
  url: string;
  clock: Clock;
  /** Cache TTL in ms. Defaults to 6 hours. */
  ttlMs?: number;
  /** Fetch a fresh `{ clients, projects }` pair, e.g. `createPocketBaseCatalogFetcher(...)`. */
  fetchCatalog: () => Promise<{ clients: Client[]; projects: Project[] }>;
}

/**
 * Disk-backed {@link Catalog}: `read()` is a synchronous, cheap read of the
 * last known snapshot (memoised after the first disk read so repeated
 * calls in one process never re-stat/re-parse); `refresh()` fetches, caches
 * to disk atomically (tmp + rename, mirroring `file-inflight-store.ts`),
 * and never throws — a failed refresh resolves `undefined` and leaves the
 * previous snapshot (if any) untouched.
 */
export class CachedCatalog implements Catalog {
  private readonly deps: CachedCatalogDeps;
  private memo: CatalogSnapshot | undefined;
  private memoized = false;

  constructor(deps: CachedCatalogDeps) {
    this.deps = deps;
  }

  read(): CatalogSnapshot | undefined {
    if (!this.memoized) {
      this.memo = this.readDisk();
      this.memoized = true;
    }
    return this.memo;
  }

  isStale(): boolean {
    const snapshot = this.read();
    if (!snapshot) return true;
    const ttl = this.deps.ttlMs ?? DEFAULT_TTL_MS;
    return this.deps.clock.now() - snapshot.fetchedAt > ttl;
  }

  async refresh(): Promise<CatalogSnapshot | undefined> {
    try {
      const { clients, projects } = await this.deps.fetchCatalog();
      const snapshot: CatalogSnapshot = { fetchedAt: this.deps.clock.now(), url: this.deps.url, clients, projects };
      this.writeDisk(snapshot);
      this.memo = snapshot;
      this.memoized = true;
      return snapshot;
    } catch {
      return undefined;
    }
  }

  private readDisk(): CatalogSnapshot | undefined {
    try {
      if (!existsSync(this.deps.filePath)) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(this.deps.filePath, "utf8"));
      if (!isCatalogSnapshot(parsed)) return undefined;
      if (parsed.url !== this.deps.url) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private writeDisk(snapshot: CatalogSnapshot): void {
    try {
      mkdirSync(dirname(this.deps.filePath), { recursive: true });
      const tmp = `${this.deps.filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot));
      renameSync(tmp, this.deps.filePath);
    } catch {
      // Best-effort cache write: a failure here must not fail the refresh
      // itself, since the in-memory snapshot is still usable this process.
    }
  }
}
