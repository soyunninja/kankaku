import { join } from "node:path";
import { CachedCatalog, PocketBaseClient, createHubTask, createPocketBaseCatalogFetcher, resolveHubCredentials } from "kankaku-pi/hub";
import type { CatalogSnapshot } from "kankaku-pi/ports";
import type { CliDeps } from "./cli-core.ts";

const DEFAULT_REFRESH_MS = 3000;

export interface CatalogRead {
  snapshot: CatalogSnapshot;
  /** Set when the refresh failed and the cache was used instead: `catalog from cache, <age> old`. */
  text?: string;
}

/**
 * Best-effort refresh bounded by `catalogTimeoutMs`; on failure the cached
 * snapshot is used and its age reported. `undefined` when there is neither
 * credentials nor a cache (the caller then reports why). CLI commands only:
 * the hooks never call this.
 */
export async function refreshCatalog(deps: CliDeps, homeDir: string): Promise<CatalogRead | undefined> {
  const hub = resolveHubCredentials({ env: deps.env, homeDir: () => homeDir });
  if (!hub.credentials) return undefined;
  const client = new PocketBaseClient({ ...hub.credentials, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const catalog = new CachedCatalog({
    filePath: join(homeDir, ".kankaku", "catalog.json"),
    url: hub.credentials.url,
    clock: { now: deps.now },
    fetchCatalog: createPocketBaseCatalogFetcher(client),
  });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(undefined); }, deps.catalogTimeoutMs ?? DEFAULT_REFRESH_MS);
  });
  const fresh = await Promise.race([catalog.refresh(controller.signal), timeout]);
  clearTimeout(timer);
  if (fresh) return { snapshot: fresh };
  const cached = catalog.read();
  if (!cached) return undefined;
  return { snapshot: cached, text: `catalog from cache, ${formatAge(deps.now() - cached.fetchedAt)} old` };
}

/** Explicit task command only: POST and adopt before the session link is written. */
export async function createCatalogTask(deps: CliDeps, homeDir: string, projectId: string, title: string, externalRef?: string) {
  const hub = resolveHubCredentials({ env: deps.env, homeDir: () => homeDir });
  if (!hub.credentials) throw new Error("hub credentials are not configured");
  const client = new PocketBaseClient({ ...hub.credentials, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const catalog = new CachedCatalog({ filePath: join(homeDir, ".kankaku", "catalog.json"), url: hub.credentials.url, clock: { now: deps.now }, fetchCatalog: createPocketBaseCatalogFetcher(client) });
  if (!catalog.read()) throw new Error("no catalog cache");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.catalogTimeoutMs ?? DEFAULT_REFRESH_MS);
  try {
    const task = await createHubTask(client, { projectId, title, ...(externalRef ? { externalRef } : {}) }, controller.signal);
    catalog.adoptTask(task);
    return task;
  } finally { clearTimeout(timer); }
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
