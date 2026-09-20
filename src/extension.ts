import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectRole, loadConfig, loadMachine, loadSyncConfig } from "./config.ts";
import { WorkTracker } from "./domain/work-tracker.ts";
import { LazyJsonlWorkLog } from "./adapters/lazy-jsonl-work-log.ts";
import { LazyFileInflightStore } from "./adapters/lazy-file-inflight-store.ts";
import { createPiTracker } from "./adapters/pi-tracker.ts";
import { LazyProjectClientSource, LazyProjectTargetSource } from "./adapters/project-config.ts";
import { LazyExportWriter } from "./adapters/export-writer.ts";
import { resolveHubCredentials, safeHomeDir } from "./adapters/hub-credentials.ts";
import { PocketBaseClient } from "./adapters/pocketbase-client.ts";
import { createPocketBaseCatalogFetcher } from "./adapters/pocketbase-catalog.ts";
import { CachedCatalog } from "./adapters/cached-catalog.ts";
import { createSessionTarget } from "./adapters/session-target.ts";
import { resolveKankakuDir } from "./adapters/kankaku-dir.ts";
import { SyncStateStore } from "./adapters/sync-state-store.ts";
import { PocketBaseSink } from "./adapters/pocketbase-sink.ts";
import { computeSyncStatus, runSync, singleFlight } from "./adapters/sync-runner.ts";
import type { SyncTrigger } from "./adapters/sync-runner.ts";
import type { Catalog } from "./ports/catalog.ts";
import type { SessionTarget } from "./adapters/session-target.ts";
import type { SyncCommandDeps } from "./adapters/kankaku-command.ts";

export default function kankaku(pi: ExtensionAPI): void {
  const config = loadConfig();
  const role = detectRole();

  const tracker = new WorkTracker({
    clock: { now: () => Date.now() },
    interactiveTools: config.interactiveTools,
    subagentTool: config.subagentTool,
    segmentRules: config.segmentRules,
  });

  const log = new LazyJsonlWorkLog(config.dir);
  const inflight = new LazyFileInflightStore(config.dir, process.pid);

  const projectClient = new LazyProjectClientSource(config.dir);
  const exportWriter = new LazyExportWriter(config.dir);

  // Hub (PocketBase) wiring: entirely optional. When unconfigured, every
  // variable below stays undefined and createPiTracker's behaviour is
  // exactly as it is without this feature. See README "Hub (PocketBase)".
  let catalog: Catalog | undefined;
  let sessionTarget: SessionTarget | undefined;
  let machine: string | undefined;
  let hubConfigError: string | undefined;
  let sync: SyncCommandDeps | undefined;
  let autoSyncEnabled: boolean | undefined;

  // `homeDir` is passed as a reference, never invoked here: any failure
  // resolving it (no HOME, a sandbox) must not fail extension load for
  // every process, hub-configured or not. resolveHubCredentials guards the
  // call itself and treats it the same as "no home directory".
  const hub = resolveHubCredentials({ env: process.env, homeDir: homedir });
  hubConfigError = hub.invalidReason;

  if (hub.credentials) {
    const credentials = hub.credentials;
    const client = new PocketBaseClient({ url: credentials.url, email: credentials.email, password: credentials.password });
    // Same defensive resolution as above; falls back to the OS temp dir
    // when no home directory is available so an env-only hub configuration
    // still works without one (the cache just does not survive a reboot).
    const homeDirForCache = safeHomeDir(homedir) ?? tmpdir();
    catalog = new CachedCatalog({
      // Machine-wide cache: several projects on the same machine share one
      // catalog fetch, and it survives across projects.
      filePath: join(homeDirForCache, ".kankaku", "catalog.json"),
      url: credentials.url,
      clock: { now: () => Date.now() },
      fetchCatalog: createPocketBaseCatalogFetcher(client),
    });

    const projectTarget = new LazyProjectTargetSource(config.dir);
    sessionTarget = createSessionTarget({
      role,
      catalog,
      resolveProjectConfigIds: () => projectTarget.read(),
      persistProjectConfig: (ids) => projectTarget.write(ids),
    });

    machine = loadMachine(process.env, () => hostname());

    // Sync (Phase 2): pushes consolidated task rows to the hub. See README
    // "Hub (PocketBase)" sync section. `worklog.jsonl` and the crash-recovery
    // checkpoints above are entirely unaffected by any of this.
    const syncConfig = loadSyncConfig(process.env);
    const syncStateStore = new SyncStateStore({ dir: resolveKankakuDir(config.dir, process.cwd()), pid: process.pid });
    const catalogRef = catalog;
    const machineName = machine;

    const runOnce = (options?: { full?: boolean; trigger?: SyncTrigger }) => {
      const snapshot = catalogRef.read();
      const sink = new PocketBaseSink({
        client,
        clients: snapshot?.clients ?? [],
        projects: snapshot?.projects ?? [],
        machine: machineName,
        promptMode: syncConfig.promptMode,
        syncRecords: syncConfig.syncRecords,
      });
      return runSync(
        {
          log,
          sink,
          stateStore: syncStateStore,
          clock: { now: () => Date.now() },
          target: credentials.url,
          windowHours: syncConfig.windowHours,
          minAutoIntervalMs: syncConfig.minIntervalMinutes * 60 * 1000,
        },
        options,
      );
    };

    sync = {
      // Single-flight: the same wrapped function backs the manual /kankaku
      // sync command and both automatic triggers (pi-tracker.ts), so they
      // never race within this process.
      run: singleFlight(runOnce),
      status: () => computeSyncStatus(log, syncStateStore, credentials.url, syncConfig.windowHours),
    };
    autoSyncEnabled = syncConfig.auto;
  }

  createPiTracker(pi, {
    tracker,
    log,
    inflight,
    role,
    pid: process.pid,
    parentPid: process.ppid,
    ...(config.client !== undefined ? { envClient: config.client } : {}),
    resolveProjectClient: () => projectClient.read(),
    writeExportFile: (name, content) => exportWriter.write(name, content),
    ...(sessionTarget !== undefined ? { sessionTarget } : {}),
    ...(catalog !== undefined ? { catalog } : {}),
    ...(machine !== undefined ? { machine } : {}),
    ...(hubConfigError !== undefined ? { hubConfigError } : {}),
    ...(sync !== undefined ? { sync } : {}),
    ...(autoSyncEnabled !== undefined ? { autoSyncEnabled } : {}),
  });
}
