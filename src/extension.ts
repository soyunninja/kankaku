import { homedir, hostname, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectRole, loadConfig, loadMachine, loadSyncConfig } from "./config.ts";
import { WorkTracker } from "./domain/work-tracker.ts";
import { findAncestorEntry } from "./domain/ancestry-match.ts";
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
import { snapshotAncestry, walkAncestry } from "./adapters/ancestry.ts";
import { MachineProcessRegistry } from "./adapters/machine-process-registry.ts";
import { RegistryAwareWorkLog } from "./adapters/registry-aware-work-log.ts";
import { JsonlWorkLog } from "./adapters/jsonl-work-log.ts";
import { resolveAgentVersion, resolvePluginVersion } from "./adapters/agent-info.ts";
import type { Catalog } from "./ports/catalog.ts";
import type { SessionTarget } from "./adapters/session-target.ts";
import type { SyncCommandDeps } from "./adapters/kankaku-command.ts";

export default function kankaku(pi: ExtensionAPI): void {
  const config = loadConfig();

  // Machine-wide process registry (ADR 0023): independent of any project's
  // KANKAKU_DIR, so a subagent running in a different git worktree can
  // still discover its true orchestrator. One OS ancestor-chain snapshot at
  // most, taken here, synchronously, before any pi.on handler is
  // registered — never on a later hot path (SUBAGENT-REQ-011). Every
  // operation on `registry` degrades to a no-op/empty-read on its own when
  // the registry is unavailable (no home dir, no permission) — see
  // adapters/machine-process-registry.ts.
  const registry = new MachineProcessRegistry(homedir);
  const registryEntries = registry.readAll();
  // One ancestry snapshot, reused for every purpose below (ppid map, this
  // process's own start identity, and the sweep's stale-by-reuse check) —
  // still a single `ps`/`proc` read, never a second spawn.
  const ancestrySnapshot = snapshotAncestry();
  const ancestorPids = walkAncestry(process.ppid, ancestrySnapshot.ppidByPid);
  const liveStartId = (pid: number): number | undefined => ancestrySnapshot.startIdByPid.get(pid);
  const ancestorEntry = findAncestorEntry(ancestorPids, registryEntries, liveStartId);

  const { role, roleConfidence } = detectRole(process.env, ancestorEntry !== undefined);
  const orchestratorRef =
    role === "subagent" && ancestorEntry !== undefined
      ? { pid: ancestorEntry.pid, project: ancestorEntry.project, startedAt: ancestorEntry.startedAt }
      : undefined;

  // This process's own OS-reported start-time identity, from the same
  // snapshot (it lists every process on the machine, this one included) —
  // see `ports/process-registry.ts#RegistryEntry.processStartId`.
  // `undefined` when unavailable (Windows, or the snapshot missed it),
  // which the registry/matching machinery already treats as "unprovable"
  // rather than a guess.
  const ownProcessStartId = ancestrySnapshot.startIdByPid.get(process.pid);

  const resolvedDir = resolveKankakuDir(config.dir, process.cwd());
  registry.record(
    {
      pid: process.pid,
      parentPid: process.ppid,
      role,
      project: process.cwd(),
      dir: resolvedDir,
      startedAt: new Date().toISOString(),
      ...(orchestratorRef !== undefined ? { orchestratorRef } : {}),
      ...(ownProcessStartId !== undefined ? { processStartId: ownProcessStartId } : {}),
    },
    undefined,
    { liveStartId },
  );

  // Best-effort cleanup of this process's own registry file: on a normal
  // exit (covers session_shutdown too, whichever fires first — `removeOwn`
  // is idempotent, a second call simply finds nothing to do) and directly
  // on `session_shutdown` for the common graceful-shutdown path. Never
  // relies on this alone for correctness — a crash still leaves the entry
  // for the next process's sweep to discard (dead-pid, or later
  // stale-by-reuse) — this only keeps `run/` tidy sooner in the common case.
  const removeOwnRegistryEntry = (): void => {
    registry.removeOwn?.(process.pid, ownProcessStartId);
  };
  process.on("exit", removeOwnRegistryEntry);
  pi.on("session_shutdown", () => {
    try {
      removeOwnRegistryEntry();
    } catch {
      // Never let registry cleanup break shutdown.
    }
  });

  const tracker = new WorkTracker({
    clock: { now: () => Date.now() },
    interactiveTools: config.interactiveTools,
    subagentTool: config.subagentTool,
    segmentRules: config.segmentRules,
  });

  const log = new RegistryAwareWorkLog({
    inner: new LazyJsonlWorkLog(config.dir),
    registry,
    readForeignRecords: (dir) => {
      try {
        return new JsonlWorkLog(dir).readAll();
      } catch {
        return [];
      }
    },
  });
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

    // Resolved once, here (never on a hot path): see README "Hub
    // (PocketBase)" > "Agent and measurement quality". Both degrade to
    // `undefined` on any failure rather than guessing.
    const agentVersion = resolveAgentVersion();
    // extension.ts lives at <package root>/src/extension.ts.
    const pluginPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pluginVersion = resolvePluginVersion(pluginPackageRoot);

    const runOnce = (options?: { full?: boolean; trigger?: SyncTrigger }) => {
      const snapshot = catalogRef.read();
      const sink = new PocketBaseSink({
        client,
        clients: snapshot?.clients ?? [],
        projects: snapshot?.projects ?? [],
        machine: machineName,
        promptMode: syncConfig.promptMode,
        syncRecords: syncConfig.syncRecords,
        agent: "pi",
        ...(agentVersion !== undefined ? { agentVersion } : {}),
        plugin: "kankaku",
        ...(pluginVersion !== undefined ? { pluginVersion } : {}),
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
    ...(roleConfidence !== undefined ? { roleConfidence } : {}),
    ...(orchestratorRef !== undefined ? { orchestratorRef } : {}),
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
    // Fresh ancestry snapshot on demand, only when `/kankaku doctor` is
    // actually invoked (never on a hot path): a stale snapshot from
    // extension startup could no longer tell a genuine pid reuse apart
    // from a still-live process for a session that has been running a while.
    registryHealth: () => {
      const freshSnapshot = snapshotAncestry();
      return registry.health({ liveStartId: (pid) => freshSnapshot.startIdByPid.get(pid) });
    },
  });
}
