/**
 * Shared hub adapter: credentials, catalog and per-project sync, used by
 * both the Catalog/Sync screens and their `kankaku catalog`/`kankaku sync`
 * subcommands. Mirrors kankaku-claude's `sync-cli.ts#syncConfigured` (see
 * `odd/tasks/screens-tasks-catalog-sync.md`), but scoped to one explicit
 * `ProjectRef` per call rather than the process's own `cwd`, since one TUI
 * process can sync several projects.
 */
import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CachedCatalog,
  JsonlWorkLog,
  PocketBaseClient,
  PocketBaseSink,
  SyncStateStore,
  computeSyncStatus,
  createPocketBaseCatalogFetcher,
  resolveHubCredentials,
  runSync,
  safeHomeDir,
} from "kankaku/hub";
import type { HubCredentials, SyncStatusSnapshot, SyncSummary } from "kankaku/hub";
import type { CatalogSnapshot } from "kankaku/ports";
import type { WorkSink } from "kankaku/ports";
import type { ProjectRef } from "../ports/project-source.ts";

export interface ResolveHubDeps {
  env: NodeJS.ProcessEnv;
  homeDir: () => string;
}

export type HubResolution = { ok: true; credentials: HubCredentials } | { ok: false; reason: string };

const HUB_UNCONFIGURED_REASON = "hub credentials are not configured (KANKAKU_PB_URL/_EMAIL/_PASSWORD or ~/.kankaku/credentials.json)";

/** Resolve hub credentials via kankaku's own `resolveHubCredentials`, collapsing its result into one pass/fail outcome with a display reason for the Catalog/Sync screens and subcommands. */
export function resolveHub(deps: ResolveHubDeps): HubResolution {
  const { credentials, invalidReason } = resolveHubCredentials(deps);
  if (invalidReason) return { ok: false, reason: `invalid hub URL: ${invalidReason}` };
  if (!credentials) return { ok: false, reason: HUB_UNCONFIGURED_REASON };
  return { ok: true, credentials };
}

export interface CreateCatalogDeps {
  homeDir: () => string;
  now: () => number;
  fetch?: typeof fetch;
}

/** Build the disk-backed `CachedCatalog` (`<homeDir>/.kankaku/catalog.json`) for `credentials`, mirroring kankaku-claude's `syncConfigured`. */
export function createCatalog(credentials: HubCredentials, deps: CreateCatalogDeps): CachedCatalog {
  const client = new PocketBaseClient({ ...credentials, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const home = safeHomeDir(deps.homeDir) ?? deps.homeDir();
  return new CachedCatalog({
    filePath: join(home, ".kankaku", "catalog.json"),
    url: credentials.url,
    clock: { now: deps.now },
    fetchCatalog: createPocketBaseCatalogFetcher(client),
  });
}

/** Refresh `catalog` against the hub and return the new snapshot (`undefined` on failure — see `CachedCatalog.refresh`). */
export function refreshCatalog(catalog: CachedCatalog): Promise<CatalogSnapshot | undefined> {
  return catalog.refresh();
}

/** `KANKAKU_SYNC_WINDOW_HOURS`, parsed the same way as kankaku's own sync paths; defaults to 24. */
function windowHours(env: NodeJS.ProcessEnv): number {
  const value = Number(env.KANKAKU_SYNC_WINDOW_HOURS);
  return env.KANKAKU_SYNC_WINDOW_HOURS && Number.isFinite(value) && value > 0 ? value : 24;
}

/** `KANKAKU_SYNC_PROMPT`, defaulting to `"none"`. */
function promptMode(env: NodeJS.ProcessEnv): "none" | "truncated" | "full" {
  const value = env.KANKAKU_SYNC_PROMPT;
  return value === "truncated" || value === "full" ? value : "none";
}

/** This package's own `version`, read from its `package.json` next to `dist/adapters/hub.js` (or `src/adapters/hub.ts` under `tsx`). */
function packageVersion(): string {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

/** Read `<project.dir>/.kankaku` as a no-network sync status snapshot: pending count, tasks stale outside the revisit window, and the persisted `SyncState` (if any). Never touches any project other than `project`. */
export function computeProjectSyncStatus(project: ProjectRef, credentials: HubCredentials, env: NodeJS.ProcessEnv): SyncStatusSnapshot {
  const dir = join(project.dir, ".kankaku");
  const log = new JsonlWorkLog(dir);
  const stateStore = new SyncStateStore({ dir, pid: process.pid });
  return computeSyncStatus(log, stateStore, credentials.url, windowHours(env));
}

export interface SyncProjectDeps {
  env: NodeJS.ProcessEnv;
  homeDir: () => string;
  now: () => number;
  hostname?: () => string;
  fetch?: typeof fetch;
}

/**
 * Sync one project against the hub: mirrors kankaku-claude's
 * `sync-cli.ts#syncConfigured` (`JsonlWorkLog`, `SyncStateStore`,
 * `PocketBaseSink` fed the refreshed catalog snapshot including `tasks`,
 * `runSync`), but stamped with this TUI's own agent/plugin identity —
 * `agent: "unknown"` (kankaku's `hub-entry.ts` prefers the record's own
 * `agent` when it carries one, so this fallback only ever reaches a
 * never-labelled legacy row) and `plugin: "kankaku-tui"`. Never touches
 * any project other than `project`.
 */
export async function syncProject(
  project: ProjectRef,
  credentials: HubCredentials,
  options: { full?: boolean },
  deps: SyncProjectDeps,
): Promise<SyncSummary> {
  const dir = join(project.dir, ".kankaku");
  const log = new JsonlWorkLog(dir);
  const stateStore = new SyncStateStore({ dir, pid: process.pid, now: deps.now });
  const catalog = createCatalog(credentials, deps);
  // On an offline hub the cached snapshot (if any) remains usable.
  await catalog.refresh();
  const snapshot = catalog.read();
  const pluginVersion = packageVersion();

  const sink: WorkSink = {
    push: async (tasks) => {
      if (tasks.length === 0) return [];
      const client = new PocketBaseClient({ ...credentials, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      return new PocketBaseSink({
        client,
        clients: snapshot?.clients ?? [],
        projects: snapshot?.projects ?? [],
        tasks: snapshot?.tasks ?? [],
        machine: deps.env.KANKAKU_MACHINE || (deps.hostname ?? osHostname)(),
        promptMode: promptMode(deps.env),
        syncRecords: deps.env.KANKAKU_SYNC_RECORDS !== "0",
        agent: "unknown",
        plugin: "kankaku-tui",
        pluginVersion,
      }).push(tasks);
    },
  };

  return runSync(
    { log, sink, stateStore, clock: { now: deps.now }, target: credentials.url, windowHours: windowHours(deps.env) },
    options,
  );
}
