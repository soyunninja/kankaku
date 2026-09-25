import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isValidClient } from "../domain/client-label.ts";
import { formatWorkTargetLabel } from "../domain/work-target.ts";
import type { RegistryClassification } from "../domain/registry-health.ts";
import type { SubagentProfile } from "../domain/subagent-profile.ts";
import type { KankakuConfig, RejectedChildEnvMarker } from "../config.ts";
import type { OrchestratorRef, WorkRecord, WorkRecordCore, WorkRole } from "../domain/work-record.ts";
import type { WorkTracker } from "../domain/work-tracker.ts";
import type { Catalog } from "../ports/catalog.ts";
import type { InflightStore } from "../ports/inflight-store.ts";
import type { WorkLog } from "../ports/work-log.ts";
import { createSessionClient } from "./session-client.ts";
import { readNonDefaultSessionDir } from "./session-dir.ts";
import type { SessionTarget } from "./session-target.ts";
import { createStatusBar } from "./status-bar.ts";
import { appendReportEntry, notifyError, registerKankakuCommand } from "./kankaku-command.ts";
import type { KankakuCommandDeps, SyncCommandDeps } from "./kankaku-command.ts";
import { openKankakuPanel } from "./panel/kankaku-panel.ts";
import { createAboutScreen } from "./panel/screens/about.ts";
import { createDoctorScreen } from "./panel/screens/doctor.ts";
import { createReportScreen } from "./panel/screens/report.ts";
import { createTargetScreen } from "./panel/screens/target.ts";
import type { SyncTrigger } from "./sync-runner.ts";

export type { KankakuReportData } from "./kankaku-command.ts";

export interface PiTrackerDeps {
  tracker: WorkTracker;
  log: WorkLog;
  /** Crash-recovery checkpoint store; see the "Crash recovery" README section. */
  inflight: InflightStore;
  role: WorkRole;
  /**
   * Static `roleConfidence`, applied from the very first record this
   * process builds. Back-compat / direct-injection path: prefer
   * {@link resolveRoleConfidence} for real wiring (`extension.ts`), since
   * interactivity (F3) is normally only knowable once pi's own
   * `ExtensionContext` is available at `session_start`, later than this
   * object is constructed. When both are set, `resolveRoleConfidence`
   * (once it has run, at `session_start`) wins. Never counted as a new task
   * locally or synced to the hub when `"uncertain"` — see
   * `domain/task-view.ts#buildTasks`/`uncertainRecords` and
   * `triggerAutoSync` below.
   */
  roleConfidence?: "uncertain";
  /**
   * Deferred `roleConfidence` resolution (F3, ADR 0022 refined): called
   * once, at `session_start`, with whether this is an interactive TUI
   * session (`ctx.mode === "tui"`) — the signal a verified tracked ancestor
   * alone cannot supply, since every subagent mechanism kankaku recognises
   * launches its child non-interactively. `role` itself never depends on
   * this (only `GENTLE_PI_AGENTS_CHILD`/`KANKAKU_ROLE` decide it, both
   * already final at factory time); only whether an `"orchestrator"` record
   * is further flagged `uncertain`. Once set here, stays stable for the
   * rest of this process's life (every `session_start` after the first
   * simply recomputes the same answer, since interactivity cannot change
   * mid-process).
   */
  resolveRoleConfidence?: (isInteractive: boolean) => "uncertain" | undefined;
  /**
   * Set only when `role` is `"subagent"` and this process discovered a
   * tracked ancestor via the machine-wide process registry (ADR 0023,
   * F1/F4's rewrite). Attached to every record this process appends so
   * `matchChildren` can reunite it with its orchestrator even across a
   * different project/`KANKAKU_DIR` — its `dir` field is also what
   * `extension.ts` uses to route this process's own work log/inflight
   * checkpoints straight into the real orchestrator's directory, so the
   * two records end up in the same `worklog.jsonl` to begin with.
   */
  orchestratorRef?: OrchestratorRef;
  /**
   * SUBAGENT-REQ-005/017: the {@link SubagentProfile} `id` whose child-env
   * marker(s) confirmed this process's `role: "subagent"` (see
   * `adapters/process-identity.ts#ProcessIdentity.profile`). Attached to
   * every record this process appends so `/kankaku doctor` can report which
   * profile matched each record. Never set for an `orchestrator` record.
   */
  profile?: string;
  /** The full active subagent-profile set, forwarded to `/kankaku doctor` — see `kankaku-command.ts#KankakuCommandDeps.subagentProfiles`. */
  subagentProfiles?: SubagentProfile[];
  pid: number;
  parentPid: number;
  /** Status line refresh interval in ms. Defaults to 1000. */
  statusIntervalMs?: number;
  /** Whether a pid is still alive. Defaults to signal-probing with `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Default billing client for this project, from `KANKAKU_CLIENT` (config.ts). See `domain/client-label.ts`. */
  envClient?: string;
  /**
   * Lazily reads the project's default billing client from
   * `<kankaku dir>/config.json`. Injected from `extension.ts` so this
   * adapter stays free of filesystem code.
   */
  resolveProjectClient?: () => string | undefined;
  /**
   * Write an export file (name, content) under the kankaku dir and return
   * its absolute path. Injected from `extension.ts` to keep this adapter
   * free of filesystem code. `/kankaku export` notifies an error when this
   * is not configured.
   */
  writeExportFile?: (name: string, content: string) => string;
  /**
   * Present only when the hub (PocketBase) is configured; see README "Hub
   * (PocketBase)". Drives the session-start picker and the `/kankaku
   * target`/`catalog` commands. Absent entirely when the hub is not
   * configured, so behaviour and record shape are unchanged for users
   * without one.
   */
  sessionTarget?: SessionTarget;
  /** This machine's hostname or `KANKAKU_MACHINE`; only attached to records when `sessionTarget` is present. */
  machine?: string;
  /** Present only when the hub is configured; forwarded to `/kankaku catalog refresh` and the hub-aware `/kankaku client`. */
  catalog?: Catalog;
  /** A configured-but-rejected hub URL (see `adapters/hub-credentials.ts`); surfaced once via `ctx.ui.notify` on the first `session_start`. */
  hubConfigError?: string;
  /** Present only when the hub is configured; forwarded to `/kankaku sync [all|status]` and `/kankaku backfill`. */
  sync?: SyncCommandDeps;
  /** Forwarded to `/kankaku doctor`; see `kankaku-command.ts#KankakuCommandDeps.registryHealth`. */
  registryHealth?: () => RegistryClassification;
  /** Forwarded to `/kankaku doctor` (F2); see `kankaku-command.ts#KankakuCommandDeps.ancestorDetectionAvailable`. */
  ancestorDetectionAvailable?: () => boolean;
  /** Forwarded to `/kankaku doctor` (F3); see `kankaku-command.ts#KankakuCommandDeps.roleOverride`. */
  roleOverride?: "orchestrator" | "subagent";
  /**
   * Whether `GENTLE_PI_AGENTS_CHILD=1` (the confirmed child marker) was
   * also present on this process (R1); forwarded to `/kankaku doctor` so it
   * can flag "override present AND child marker present" with the resolved
   * outcome — see `kankaku-command.ts#KankakuCommandDeps.childMarkerPresent`.
   */
  childMarkerPresent?: boolean;
  /**
   * Set when `KANKAKU_ROLE=subagent` was present, with no confirmed child
   * marker, but was ignored because this process looked interactive (R1 —
   * see `config.ts#detectRole`'s precedence doc). Surfaced once via
   * `ctx.ui.notify` at `session_start` and forwarded to `/kankaku doctor`.
   */
  overrideIgnoredInteractive?: boolean;
  /**
   * C2 (CRITICAL fix): set when a USER-CONFIGURED child-env marker
   * (`KANKAKU_SUBAGENT_CHILD_ENV`) was present, but was ignored because
   * this process looked interactive — a configured marker never demotes an
   * interactive session (see `config.ts#detectRole`'s precedence doc).
   * Surfaced once via `ctx.ui.notify` at `session_start` and forwarded to
   * `/kankaku doctor`; escalated there (C2 item 3's self-check) when this
   * process also has no tracked ancestor at all — the strongest signal the
   * marker is genuinely ambient.
   */
  configuredMarkerIgnoredInteractive?: boolean;
  /** C2 item 3: whether a live tracked ancestor was found for this process (`adapters/process-identity.ts#ProcessIdentity.hasTrackedAncestor`) — combined with `configuredMarkerIgnoredInteractive` above to decide the doctor self-check's wording. */
  hasTrackedAncestor?: boolean;
  /**
   * C2 (CRITICAL fix, item 1): every `KANKAKU_SUBAGENT_CHILD_ENV` marker
   * `config.ts#validateSubagentChildEnvMarkers` rejected as looking
   * pi/shell/OS/npm-owned rather than genuinely child-only. Surfaced once
   * via `ctx.ui.notify` at `session_start` and forwarded to `/kankaku
   * doctor`. Absent (never an empty array) when nothing was rejected.
   */
  rejectedSubagentChildEnvMarkers?: RejectedChildEnvMarker[];
  /** Forwarded to `/kankaku doctor` (F1); see `kankaku-command.ts#KankakuCommandDeps.workLogRouting`. */
  workLogRouting?: { usedFallback: boolean; parentDir: string };
  /**
   * `KANKAKU_SYNC_AUTO` (default enabled): when `true` and `sync` is
   * present, fire-and-forget a sync on `session_start` (orchestrator role
   * only, after crash recovery) and again after `agent_settled`. Both go
   * through `sync.run`, which callers are expected to wrap with a
   * single-flight guard (see `adapters/sync-runner.ts#singleFlight`) so
   * these two triggers never race. Never awaited; errors are swallowed
   * (`sync.run` never throws) and surfaced at most once per session via a
   * quiet notification, never on success.
   */
  autoSyncEnabled?: boolean;
  /**
   * Upper bound (ms) on how long the `session_shutdown` handler awaits
   * `sync.run({ trigger: "session_shutdown" })` before giving up and
   * letting cleanup proceed regardless. pi awaits `session_shutdown`
   * handlers with no timeout of its own (verified in pi's dist), so this
   * is the only thing bounding how long quitting can take when the hub is
   * unreachable. Defaults to 3000; injectable so tests never wait on a
   * real timer.
   */
  shutdownSyncTimeoutMs?: number;
  /**
   * The full active kankaku configuration (`config.ts#loadConfig`), for the
   * panel's `about` screen (P3). Optional so every existing direct
   * `createPiTracker` caller (e.g. `tests/pi-tracker.test.ts`) keeps
   * working unchanged — falls back to {@link FALLBACK_ABOUT_CONFIG} (an
   * empty configuration) when absent. `extension.ts` always supplies the
   * real one.
   */
  config?: KankakuConfig;
  /** This session's resolved kankaku directory (`adapters/kankaku-dir.ts#resolveKankakuDir`), for the `about` screen. */
  kankakuDir?: string;
  /** pi's version (`adapters/agent-info.ts#resolveAgentVersion`), for the `about` screen. */
  agentVersion?: string;
  /** kankaku's own version (`adapters/agent-info.ts#resolvePluginVersion`), for the `about` screen. */
  pluginVersion?: string;
  /** The hub (PocketBase) URL, when configured, for the `about` screen. */
  hubUrl?: string;
}

/** Default for {@link PiTrackerDeps.shutdownSyncTimeoutMs}. */
const DEFAULT_SHUTDOWN_SYNC_TIMEOUT_MS = 3000;

/** {@link PiTrackerDeps.config}'s fallback for a caller that has not wired the real one yet. */
const FALLBACK_ABOUT_CONFIG: KankakuConfig = {
  dir: ".kankaku",
  interactiveTools: [],
  subagentProfiles: [],
  segmentRules: [],
  rejectedSubagentChildEnvMarkers: [],
};

/** Default `isAlive`: probe with signal 0 — no signal is sent, only existence/permission is checked. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we lack permission to signal it — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Wraps a handler so it never throws out of the pi event loop. */
function guarded<E>(fn: (event: E, ctx: ExtensionContext) => void): (event: E, ctx: ExtensionContext) => void {
  return (event, ctx) => {
    try {
      fn(event, ctx);
    } catch (error) {
      notifyError(ctx, error);
    }
  };
}

/** Async counterpart of {@link guarded}: also catches a rejected promise, e.g. from the target picker's `ctx.ui.select`. */
function guardedAsync<E>(fn: (event: E, ctx: ExtensionContext) => Promise<void>): (event: E, ctx: ExtensionContext) => Promise<void> {
  return async (event, ctx) => {
    try {
      await fn(event, ctx);
    } catch (error) {
      notifyError(ctx, error);
    }
  };
}

/**
 * Wires pi lifecycle events to a {@link WorkTracker}, persisting finished
 * records to a {@link WorkLog} and exposing the `/kankaku` report command.
 */
export function createPiTracker(pi: ExtensionAPI, deps: PiTrackerDeps): void {
  const { tracker, log, inflight, role, pid, parentPid } = deps;
  const isAlive = deps.isAlive ?? defaultIsAlive;

  /**
   * F3: mutable so `session_start` can finalise it once `ctx.mode` (and
   * therefore interactivity) is known — see `resolveRoleConfidence` above.
   * Starts from the static `roleConfidence`, if any, so a caller that never
   * fires `session_start` at all (e.g. most existing tests) still behaves
   * exactly as before this change.
   */
  let roleConfidence: "uncertain" | undefined = deps.roleConfidence;

  const sessionClient = createSessionClient({
    role,
    envClient: deps.envClient,
    resolveProjectClient: deps.resolveProjectClient,
  });

  /** Prefer the hub target's display label over the legacy client label, when one is active. */
  function runDisplayLabel(): string | undefined {
    const target = deps.sessionTarget?.runTarget();
    return target ? formatWorkTargetLabel(target) : sessionClient.runClient();
  }

  function idleDisplayLabel(): string | undefined {
    const target = deps.sessionTarget?.idleTarget();
    return target ? formatWorkTargetLabel(target) : sessionClient.idleClient();
  }

  const statusBar = createStatusBar({
    intervalMs: deps.statusIntervalMs,
    resolveRunClient: runDisplayLabel,
    resolveIdleClient: idleDisplayLabel,
  });

  const refreshIdleStatus = (ctx: ExtensionContext) => statusBar.showIdle(ctx);

  // Built as a named const (rather than inlined into `registerKankakuCommand`
  // below) so `openPanel`'s doctor screen can reuse the exact same
  // `KankakuCommandDeps` `buildDoctorLines` needs — the panel and
  // `/kankaku doctor` can then never drift. Safe to reference `commandDeps`
  // from within its own `openPanel` closure: the closure body only runs
  // once `/kankaku` (no args) is actually invoked, long after this `const`
  // has finished initializing.
  const commandDeps: KankakuCommandDeps = {
    log,
    sessionClient,
    refreshIdleStatus,
    writeExportFile: deps.writeExportFile,
    sessionTarget: deps.sessionTarget,
    catalog: deps.catalog,
    sync: deps.sync,
    registryHealth: deps.registryHealth,
    ancestorDetectionAvailable: deps.ancestorDetectionAvailable,
    roleOverride: deps.roleOverride,
    childMarkerPresent: deps.childMarkerPresent,
    overrideIgnoredInteractive: deps.overrideIgnoredInteractive,
    configuredMarkerIgnoredInteractive: deps.configuredMarkerIgnoredInteractive,
    hasTrackedAncestor: deps.hasTrackedAncestor,
    rejectedSubagentChildEnvMarkers: deps.rejectedSubagentChildEnvMarkers,
    workLogRouting: deps.workLogRouting,
    subagentProfiles: deps.subagentProfiles,
    // The hub is configured exactly when a session target is wired (see
    // PiTrackerDeps.sessionTarget's doc comment): the panel's root menu
    // uses the same signal to decide whether to offer `sync` — `target`
    // itself is offered either way, since the legacy `/kankaku client
    // <name>` label lives on that same screen and works with no hub at
    // all (see `domain/panel-model.ts#rootMenu`'s `target` row).
    openPanel: (ctx) =>
      openKankakuPanel(ctx, {
        hubConfigured: deps.sessionTarget !== undefined,
        screens: {
          target: createTargetScreen({
            pi,
            ctx,
            role,
            sessionTarget: deps.sessionTarget,
            sessionClient,
            catalog: deps.catalog,
            refreshIdleStatus,
          }),
          report: createReportScreen({
            log,
            ctx,
            pi,
            sessionId: () => ctx.sessionManager.getSessionId(),
            pinReport: (report) => appendReportEntry(pi, ctx, report),
          }),
          doctor: createDoctorScreen({
            commandDeps,
            ctx,
            pinReport: (report) => appendReportEntry(pi, ctx, report),
          }),
          about: createAboutScreen({
            config: deps.config ?? FALLBACK_ABOUT_CONFIG,
            kankakuDir: deps.kankakuDir ?? deps.config?.dir ?? FALLBACK_ABOUT_CONFIG.dir,
            agentVersion: deps.agentVersion,
            pluginVersion: deps.pluginVersion,
            hubUrl: deps.hubUrl,
          }),
        },
      }),
  };
  const kankakuCommand = registerKankakuCommand(pi, commandDeps);

  /** At most one quiet auto-sync failure notification per session; never notified on success. Shared by the fire-and-forget `triggerAutoSync` and the awaited shutdown sync below. */
  let autoSyncErrorNotified = false;

  function notifyAutoSyncFailureOnce(ctx: ExtensionContext, message: string): void {
    if (autoSyncErrorNotified) return;
    autoSyncErrorNotified = true;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  }

  // An uncertain-role process (ADR 0022) never anchors a task (see
  // `domain/task-view.ts#buildTasks`), so a sync attempt from it would
  // only ever find nothing new to push — skip it outright, exactly like a
  // subagent, rather than pay for a pointless run. Shared by every
  // automatic trigger, fire-and-forget or awaited.
  function autoSyncEligible(): boolean {
    return Boolean(deps.sync) && role === "orchestrator" && roleConfidence !== "uncertain" && deps.autoSyncEnabled !== false;
  }

  /** Fire-and-forget a sync (orchestrator role, `sync` configured, auto-sync enabled). Never awaited, never throws. `trigger` lets the automatic path's version short-circuit and throttle (see `adapters/sync-runner.ts#runSync`) tell apart `session_start` from `agent_settled`. */
  function triggerAutoSync(ctx: ExtensionContext, trigger: SyncTrigger): void {
    if (!deps.sync || !autoSyncEligible()) return;
    void deps.sync
      .run({ trigger })
      .then((summary) => {
        if (summary.error) notifyAutoSyncFailureOnce(ctx, `kankaku: sync failed: ${summary.error}`);
      })
      .catch(() => {
        // sync.run is expected to never throw (see adapters/sync-runner.ts);
        // this catch only guards against a misbehaving implementation.
      });
  }

  /**
   * Awaited counterpart of {@link triggerAutoSync}, for `session_shutdown`
   * only: called after every settled record for this shutdown has already
   * been appended (see the handler below), so the sync it runs includes
   * them. Races `sync.run({ trigger: "session_shutdown" })` against
   * `shutdownSyncTimeoutMs` (default {@link DEFAULT_SHUTDOWN_SYNC_TIMEOUT_MS})
   * so an unreachable hub costs at most that timeout, never longer, and pi
   * awaits this handler with no timeout of its own. Never throws: a
   * rejection from `sync.run` (never expected — see
   * `adapters/sync-runner.ts`) is caught exactly like `triggerAutoSync`'s
   * own `.catch`, and is never left as an unhandled rejection even when the
   * timeout branch of the race wins first. Notifies at most once per
   * session, sharing {@link notifyAutoSyncFailureOnce}'s guard.
   */
  async function runShutdownSync(ctx: ExtensionContext): Promise<void> {
    if (!deps.sync || !autoSyncEligible()) return;
    const sync = deps.sync;

    const timeoutMs = deps.shutdownSyncTimeoutMs ?? DEFAULT_SHUTDOWN_SYNC_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    // Caught right here, unconditionally, so this promise never becomes an
    // unhandled rejection regardless of which side of the race below wins.
    const settled = sync
      .run({ trigger: "session_shutdown" })
      .then((summary) => ({ kind: "summary", summary }) as const)
      .catch((error: unknown) => ({ kind: "rejected", error }) as const);
    const timedOut = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });

    const outcome = await Promise.race([settled, timedOut]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome.kind === "timeout") {
      notifyAutoSyncFailureOnce(ctx, "kankaku: shutdown sync timed out");
    } else if (outcome.kind === "rejected") {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      notifyAutoSyncFailureOnce(ctx, `kankaku: sync failed: ${message}`);
    } else if (outcome.summary.error) {
      notifyAutoSyncFailureOnce(ctx, `kankaku: sync failed: ${outcome.summary.error}`);
    }
  }

  /** `log.append` plus cache invalidation, so every append this process makes keeps the completion cache correct. */
  function appendRecord(record: WorkRecord): void {
    log.append(record);
    kankakuCommand.invalidateClientNames();
  }

  function buildRecord(core: WorkRecordCore, ctx: ExtensionContext): WorkRecord {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const thinkingLevel = readThinkingLevel(pi);
    // Subagent children never carry their own client/target: they inherit
    // the orchestrator's at task level (see task-view.ts).
    const target = deps.sessionTarget?.runTarget();
    // When a hub target is active, the legacy `client` label is the
    // client's code (kept valid against CLIENT_PATTERN so every existing
    // report/export keeps working); an invalid code is omitted rather than
    // breaking the record. Without a hub target, behaviour is unchanged.
    const client = target ? (isValidClient(target.clientCode) ? target.clientCode : undefined) : sessionClient.runClient();
    const sessionName = pi.getSessionName();
    const sessionDir = readNonDefaultSessionDir(ctx.sessionManager);
    return {
      ...core,
      role,
      pid,
      parentPid,
      project: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      mode: ctx.mode,
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(client !== undefined ? { client } : {}),
      ...(sessionName !== undefined ? { sessionName } : {}),
      ...(sessionDir !== undefined ? { sessionDir } : {}),
      ...(target !== undefined
        ? {
            clientId: target.clientId,
            clientName: target.clientName,
            ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
            ...(target.projectName !== undefined ? { projectName: target.projectName } : {}),
            ...(target.hubTaskId !== undefined ? { hubTaskId: target.hubTaskId } : {}),
            ...(target.hubTaskTitle !== undefined ? { hubTaskTitle: target.hubTaskTitle } : {}),
          }
        : {}),
      ...(deps.machine !== undefined ? { machine: deps.machine } : {}),
      ...(roleConfidence !== undefined ? { roleConfidence } : {}),
      ...(deps.orchestratorRef !== undefined ? { orchestratorRef: deps.orchestratorRef } : {}),
      ...(deps.profile !== undefined ? { profile: deps.profile } : {}),
    };
  }

  /**
   * Save an in-flight checkpoint of the run's current state, so a hard
   * crash before the next one (or the final settle) still leaves a
   * recoverable `interrupted` record. A no-op while idle.
   */
  function checkpoint(ctx: ExtensionContext): void {
    const core = tracker.peek("interrupted");
    if (core) {
      inflight.save(buildRecord(core, ctx));
    }
  }

  pi.on(
    "before_agent_start",
    guarded((event, ctx) => {
      tracker.onRunStart(event.prompt);
      statusBar.start(ctx);
      // Checkpoint right away so a crash on the very first turn (before any
      // turn_end/tool_execution_end) still leaves a recoverable in-flight
      // record; see the "Crash recovery" README section.
      checkpoint(ctx);
    }),
  );

  pi.on(
    "agent_start",
    guarded((_event, ctx) => {
      // A run an extension started itself never fires before_agent_start
      // (see WorkTracker.onAgentStart): open the record, the status clock and
      // the crash-recovery checkpoint here instead. A no-op for a user prompt.
      const wasIdle = tracker.peek("interrupted") === undefined;
      tracker.onAgentStart();
      if (wasIdle) statusBar.start(ctx);
      // Always: when this start set a record aside, the checkpoint on disk
      // must become the merged snapshot now, not at the next turn_end.
      checkpoint(ctx);
    }),
  );

  pi.on(
    "agent_end",
    guarded((event) => {
      tracker.onRunEnd(event.messages);
    }),
  );

  pi.on(
    "turn_end",
    guarded((event, ctx) => {
      const message = event.message;
      const usage = message && "usage" in message ? message.usage : undefined;
      const cost = usage && typeof usage.cost === "object" && usage.cost !== null ? usage.cost.total : undefined;
      tracker.onTurnEnd(
        usage
          ? {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              cost,
            }
          : undefined,
      );
      checkpoint(ctx);
    }),
  );

  pi.on(
    "tool_execution_start",
    guarded((event) => {
      tracker.onToolStart(event.toolCallId, event.toolName, event.args);
    }),
  );

  pi.on(
    "tool_execution_end",
    guarded((event, ctx) => {
      tracker.onToolEnd(event.toolCallId, event.result);
      checkpoint(ctx);
    }),
  );

  pi.on(
    "ui_prompt_start",
    guarded((event) => {
      tracker.onUiPromptStart(event.kind);
    }),
  );

  pi.on(
    "ui_prompt_end",
    guarded((event) => {
      tracker.onUiPromptEnd(event.kind);
    }),
  );

  pi.on(
    "agent_settled",
    guarded((_event, ctx) => {
      const cores = tracker.settleAll();
      try {
        for (const core of cores) {
          appendRecord(buildRecord(core, ctx));
        }
      } finally {
        // Always clean up, even when appendRecord above threw: an unpersisted
        // checkpoint must not linger, and the status timer must not leak.
        inflight.clear();
        if (tracker.peek("interrupted") !== undefined) {
          // A new run overtook this settle (see WorkTracker.settleAll): it is
          // still open, so its clock keeps running and it gets its own
          // checkpoint back — the clear above only dropped the old record's.
          checkpoint(ctx);
        } else {
          statusBar.stop(ctx);
          sessionClient.endRun();
          deps.sessionTarget?.endRun();
        }
        triggerAutoSync(ctx, "agent_settled");
      }
    }),
  );

  pi.on(
    "session_shutdown",
    guardedAsync(async (_event, ctx) => {
      const cores = tracker.shutdownAll();
      try {
        for (const core of cores) {
          appendRecord(buildRecord(core, ctx));
        }
        // Only reached once every record above was appended: the shutdown
        // sync (bounded by runShutdownSync's own timeout, see above) must
        // include them. If appendRecord threw, this is skipped and the
        // finally below still runs cleanup — never left half-done.
        await runShutdownSync(ctx);
      } finally {
        inflight.clear();
        statusBar.stop(ctx);
        sessionClient.endRun();
        deps.sessionTarget?.endRun();
      }
    }),
  );

  let hubConfigErrorNotified = false;
  let overrideIgnoredInteractiveNotified = false;
  let configuredMarkerIgnoredInteractiveNotified = false;
  let rejectedSubagentChildEnvMarkersNotified = false;

  pi.on(
    "session_start",
    guardedAsync(async (_event, ctx) => {
      // F3: finalise roleConfidence now that ctx.mode (and therefore
      // interactivity) is known — see resolveRoleConfidence's doc comment.
      // A no-op when extension.ts did not wire it (deps.roleConfidence, if
      // any, is left exactly as constructed).
      if (deps.resolveRoleConfidence) {
        roleConfidence = deps.resolveRoleConfidence(ctx.mode === "tui");
      }

      if (deps.hubConfigError && !hubConfigErrorNotified) {
        hubConfigErrorNotified = true;
        if (ctx.hasUI) ctx.ui.notify(deps.hubConfigError, "error");
      }

      // R1: KANKAKU_ROLE=subagent was ignored at factory time (no confirmed
      // child marker, and this process looked interactive) — this is
      // almost always a leaked shell export, and honouring it would have
      // silently dropped this session's own work. Never silent: warn once.
      if (deps.overrideIgnoredInteractive && !overrideIgnoredInteractiveNotified) {
        overrideIgnoredInteractiveNotified = true;
        if (ctx.hasUI) {
          ctx.ui.notify(
            "kankaku: ignoring KANKAKU_ROLE=subagent for this interactive session (likely a leaked shell export) — treating it as orchestrator; see /kankaku doctor",
            "warning",
          );
        }
      }

      // C2 item 2/3: a KANKAKU_SUBAGENT_CHILD_ENV marker matched, but was
      // ignored because this process looked interactive — a configured
      // marker never demotes an interactive session. Escalate the wording
      // when this process ALSO has no tracked ancestor at all (the
      // strongest signal the marker is genuinely ambient, not a real
      // subagent mechanism — C2 item 3's self-check).
      if (deps.configuredMarkerIgnoredInteractive && !configuredMarkerIgnoredInteractiveNotified) {
        configuredMarkerIgnoredInteractiveNotified = true;
        if (ctx.hasUI) {
          const message = deps.hasTrackedAncestor
            ? "kankaku: ignoring a KANKAKU_SUBAGENT_CHILD_ENV marker for this interactive session — treating it as orchestrator; see /kankaku doctor"
            : "kankaku: a KANKAKU_SUBAGENT_CHILD_ENV marker matched this interactive, top-level session (no tracked ancestor) — the marker is likely ambient, not a real subagent mechanism; treating it as orchestrator; see /kankaku doctor";
          ctx.ui.notify(message, "warning");
        }
      }

      // C2 item 1: one or more KANKAKU_SUBAGENT_CHILD_ENV entries were
      // rejected at config load time (looked pi/shell/OS/npm-owned, not
      // genuinely child-only) — never silent.
      if (deps.rejectedSubagentChildEnvMarkers?.length && !rejectedSubagentChildEnvMarkersNotified) {
        rejectedSubagentChildEnvMarkersNotified = true;
        if (ctx.hasUI) {
          const names = deps.rejectedSubagentChildEnvMarkers.map((rejected) => rejected.name).join(", ");
          ctx.ui.notify(`kankaku: ignoring KANKAKU_SUBAGENT_CHILD_ENV marker(s) that look ambient, not child-only: ${names}; see /kankaku doctor`, "warning");
        }
      }

      sessionClient.restore(ctx);
      deps.sessionTarget?.restore(ctx);
      statusBar.showIdle(ctx);

      const recovered = inflight.recoverStale(isAlive);
      for (const record of recovered) {
        appendRecord(record);
      }
      if (recovered.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`kankaku: recovered ${recovered.length} interrupted record(s)`, "warning");
      }

      // Runs after recovery so a freshly picked target does not affect
      // records recovered from before this session started. See README
      // "Hub (PocketBase)": a no-op unless orchestrator + hasUI + configured.
      if (deps.sessionTarget) {
        await deps.sessionTarget.ensurePicked(pi, ctx);
        statusBar.showIdle(ctx);
      }

      // Fire-and-forget, after recovery so a just-recovered interrupted
      // record is included. See README "Hub (PocketBase)" sync section.
      triggerAutoSync(ctx, "session_start");
    }),
  );
}

/** pi's current reasoning effort, or `undefined` on a pi that predates `getThinkingLevel` or has no session to ask yet. Never throws. */
function readThinkingLevel(pi: ExtensionAPI): string | undefined {
  try {
    const read = (pi as { getThinkingLevel?: () => unknown }).getThinkingLevel;
    const level = typeof read === "function" ? read.call(pi) : undefined;
    return typeof level === "string" && level.length > 0 ? level : undefined;
  } catch {
    return undefined;
  }
}
