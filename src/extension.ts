import { homedir, hostname, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectRole, loadConfig, loadMachine, loadSyncConfig, readRoleOverride, stripRoleOverride } from "./config.ts";
import { WorkTracker } from "./domain/work-tracker.ts";
import { resolveOrchestratorRef } from "./domain/ancestry-match.ts";
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
import { resolveKankakuDir, resolveWritableTarget } from "./adapters/kankaku-dir.ts";
import { SyncStateStore } from "./adapters/sync-state-store.ts";
import { PocketBaseSink } from "./adapters/pocketbase-sink.ts";
import { computeSyncStatus, runSync, singleFlight } from "./adapters/sync-runner.ts";
import type { SyncTrigger } from "./adapters/sync-runner.ts";
import { snapshotAncestry } from "./adapters/ancestry.ts";
import { MachineProcessRegistry } from "./adapters/machine-process-registry.ts";
import { JsonlWorkLog } from "./adapters/jsonl-work-log.ts";
import { FileInflightStore } from "./adapters/file-inflight-store.ts";
import { resolveSubagentStartup } from "./adapters/subagent-startup.ts";
import { resolveAgentVersion, resolvePluginVersion } from "./adapters/agent-info.ts";
import type { Catalog } from "./ports/catalog.ts";
import type { SessionTarget } from "./adapters/session-target.ts";
import type { SyncCommandDeps } from "./adapters/kankaku-command.ts";
import type { WorkLog } from "./ports/work-log.ts";
import type { InflightStore } from "./ports/inflight-store.ts";

export default function kankaku(pi: ExtensionAPI): void {
  const config = loadConfig();

  // Machine-wide process registry (ADR 0023, rewritten by F1): independent
  // of any project's KANKAKU_DIR, so a subagent running in a different git
  // worktree can still discover its true orchestrator. The registry is a
  // STARTUP LOOKUP ONLY — "who is my tracked ancestor, and where does it
  // keep its log" — never a later pointer a reader chases again (see
  // adapters/subagent-startup.ts). Every operation on `registry` degrades
  // to a no-op/empty-read on its own when the registry is unavailable (no
  // home dir, no permission) — see adapters/machine-process-registry.ts.
  const registry = new MachineProcessRegistry(homedir);

  // F5: reads the registry first and only pays for an OS ancestor-chain
  // snapshot (`ps`/`/proc`) when at least one other entry could possibly be
  // an ancestor — the common case (no other kankaku process running) never
  // spawns anything.
  const startup = resolveSubagentStartup({
    registry,
    ppid: process.ppid,
    now: () => Date.now(),
    uptimeSeconds: () => process.uptime(),
  });
  const { ancestorEntry, ownProcessStartId } = startup;
  const hasTrackedAncestor = ancestorEntry !== undefined;

  // `role` itself only ever depends on the env marker/override — never on
  // ancestry, and (with one R1 exception below) never on interactivity
  // either — so it is safe, and correct, to decide it once, right here,
  // and never revisit it (F3: only `roleConfidence`, for an
  // `"orchestrator"` record, is deferred — see `resolveRoleConfidence`
  // below). `hasTrackedAncestor` is irrelevant to `role` itself, so `false`
  // is passed here purely to obtain it cheaply.
  //
  // R1 (BLOCKER): read KANKAKU_ROLE, and whether the confirmed child marker
  // is present, exactly once here — then strip the override from this
  // process's own env (config.ts#stripRoleOverride) so a child this
  // process spawns (a subagent runner, a tool shell) never inherits it.
  // Everything below (the registry entry, orchestratorRef, write routing,
  // session-target/client wiring) already uses the corrected `role`.
  const childMarkerPresent = process.env["GENTLE_PI_AGENTS_CHILD"] === "1";
  const roleOverride = readRoleOverride(process.env);
  // A cheap, synchronous interactivity proxy, available before pi's own
  // ExtensionContext exists (unlike the authoritative `ctx.mode === "tui"`,
  // only known later, at `session_start` — too late here, since several
  // decisions below already depend on the corrected `role`). Every
  // subagent mechanism kankaku recognises launches its child with piped,
  // non-TTY stdio, so this reliably tells a real subagent apart from a
  // leaked `KANKAKU_ROLE=subagent` shell export reaching a genuine
  // interactive terminal session — see `detectRole`'s doc comment for the
  // precedence this feeds into, and its trade-off: an unusual, unrecognised
  // subagent mechanism that happens to preserve a TTY would have its own
  // explicit `KANKAKU_ROLE=subagent` overridden by this same guess.
  const isInteractiveGuess = Boolean(process.stdout.isTTY);
  const detection = detectRole(process.env, false, isInteractiveGuess);
  const { role } = detection;
  const overrideIgnoredInteractive = detection.overrideIgnoredInteractive === true;
  stripRoleOverride(process.env);

  // F4: resolves through a subagent-of-subagent chain to the real top-level
  // orchestrator (never a middle hop), carrying that orchestrator's `dir`
  // for F1's write routing below.
  const orchestratorRef = role === "subagent" ? resolveOrchestratorRef(ancestorEntry) : undefined;

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
    { liveStartId: startup.liveStartId },
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

  // F1: a verified subagent whose real orchestrator's kankaku dir differs
  // from this process's own writes its work log AND its inflight
  // checkpoints straight into that dir — so parent and child records live
  // in the same `worklog.jsonl` forever, joined by `buildTasks`'s existing
  // pid/parentPid/project-hint keys, with no later discovery through a live
  // registry pointer ever required again (the old `RegistryAwareWorkLog`
  // read-time merge is gone: this write-side routing makes it redundant —
  // see AGENTS.md). A record is written to exactly ONE log, always: either
  // branch below constructs exactly one `WorkLog`/`InflightStore` pair,
  // pointed at the same resolved directory. `workLogRouting` is only set
  // (and only surfaced to `/kankaku doctor`) when this process actually
  // attempted routing — never for the common orchestrator/local-subagent
  // path, which keeps today's lazy, lower-cost resolution unchanged.
  let log: WorkLog;
  let inflight: InflightStore;
  let workLogRouting: { usedFallback: boolean; parentDir: string } | undefined;

  if (role === "subagent" && orchestratorRef?.dir !== undefined && orchestratorRef.dir !== resolvedDir) {
    const routed = resolveWritableTarget(orchestratorRef.dir, resolvedDir);
    log = new JsonlWorkLog(routed.dir);
    inflight = new FileInflightStore(routed.dir, process.pid);
    workLogRouting = { usedFallback: routed.usedFallback, parentDir: orchestratorRef.dir };
  } else {
    log = new LazyJsonlWorkLog(config.dir);
    inflight = new LazyFileInflightStore(config.dir, process.pid);
  }

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
    // F3: interactivity (ctx.mode === "tui") is only knowable once pi's own
    // ExtensionContext is available, at session_start — later than role
    // itself must be decided above. `hasTrackedAncestor` is already final
    // here; only isInteractive is supplied later, by pi-tracker.ts.
    //
    // R1: gated on `roleOverride === undefined` — once KANKAKU_ROLE decided
    // (or, for a `subagent` value ignored via the interactive contradiction
    // above, resolved) this process's role at factory time, that decision
    // stays final and is never later demoted to `uncertain`; this
    // refinement only ever applies to the genuine no-override path (and
    // `process.env` is safe to re-read here despite the strip below, since
    // this branch is only reached when there was nothing to strip that
    // would have mattered to it).
    resolveRoleConfidence: (isInteractive) =>
      role === "orchestrator" && roleOverride === undefined ? detectRole(process.env, hasTrackedAncestor, isInteractive).roleConfidence : undefined,
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
    ...(roleOverride !== undefined ? { roleOverride } : {}),
    ...(childMarkerPresent ? { childMarkerPresent } : {}),
    ...(overrideIgnoredInteractive ? { overrideIgnoredInteractive } : {}),
    ...(workLogRouting !== undefined ? { workLogRouting } : {}),
    // Fresh ancestry snapshot on demand, only when `/kankaku doctor` is
    // actually invoked (never on a hot path): a stale snapshot from
    // extension startup could no longer tell a genuine pid reuse apart
    // from a still-live process for a session that has been running a while.
    registryHealth: () => {
      const freshSnapshot = snapshotAncestry();
      return registry.health({ liveStartId: (pid) => freshSnapshot.startIdByPid.get(pid) });
    },
    // F2: whether the ancestor-chain mechanism itself is actually usable
    // right now — Windows, or a failed/unavailable ps/proc read on any
    // platform, both report false here. A fresh snapshot (never the one
    // taken at startup, which may have been skipped entirely — F5) since
    // this only runs when a human actually asks for `/kankaku doctor`.
    ancestorDetectionAvailable: () => snapshotAncestry().ppidByPid.size > 0,
  });
}
