import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isValidClient } from "../domain/client-label.ts";
import { formatWorkTargetLabel } from "../domain/work-target.ts";
import type { RegistryClassification } from "../domain/registry-health.ts";
import type { OrchestratorRef, WorkRecord, WorkRecordCore, WorkRole } from "../domain/work-record.ts";
import type { WorkTracker } from "../domain/work-tracker.ts";
import type { Catalog } from "../ports/catalog.ts";
import type { InflightStore } from "../ports/inflight-store.ts";
import type { WorkLog } from "../ports/work-log.ts";
import { createSessionClient } from "./session-client.ts";
import { readNonDefaultSessionDir } from "./session-dir.ts";
import type { SessionTarget } from "./session-target.ts";
import { createStatusBar } from "./status-bar.ts";
import { notifyError, registerKankakuCommand } from "./kankaku-command.ts";
import type { SyncCommandDeps } from "./kankaku-command.ts";
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
}

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

  const kankakuCommand = registerKankakuCommand(pi, {
    log,
    sessionClient,
    refreshIdleStatus: (ctx) => statusBar.showIdle(ctx),
    writeExportFile: deps.writeExportFile,
    sessionTarget: deps.sessionTarget,
    catalog: deps.catalog,
    sync: deps.sync,
    registryHealth: deps.registryHealth,
    ancestorDetectionAvailable: deps.ancestorDetectionAvailable,
    roleOverride: deps.roleOverride,
    childMarkerPresent: deps.childMarkerPresent,
    overrideIgnoredInteractive: deps.overrideIgnoredInteractive,
    workLogRouting: deps.workLogRouting,
  });

  /** At most one quiet auto-sync failure notification per session; never notified on success. */
  let autoSyncErrorNotified = false;

  /** Fire-and-forget a sync (orchestrator role, `sync` configured, auto-sync enabled). Never awaited, never throws. `trigger` lets the automatic path's version short-circuit and throttle (see `adapters/sync-runner.ts#runSync`) tell apart `session_start` from `agent_settled`. */
  function triggerAutoSync(ctx: ExtensionContext, trigger: SyncTrigger): void {
    // An uncertain-role process (ADR 0022) never anchors a task (see
    // `domain/task-view.ts#buildTasks`), so a sync attempt from it would
    // only ever find nothing new to push — skip it outright, exactly like
    // a subagent, rather than pay for a pointless run.
    if (!deps.sync || role !== "orchestrator" || roleConfidence === "uncertain" || deps.autoSyncEnabled === false) return;
    void deps.sync
      .run({ trigger })
      .then((summary) => {
        if (!summary.error || autoSyncErrorNotified) return;
        autoSyncErrorNotified = true;
        if (ctx.hasUI) ctx.ui.notify(`kankaku: sync failed: ${summary.error}`, "warning");
      })
      .catch(() => {
        // sync.run is expected to never throw (see adapters/sync-runner.ts);
        // this catch only guards against a misbehaving implementation.
      });
  }

  /** `log.append` plus cache invalidation, so every append this process makes keeps the completion cache correct. */
  function appendRecord(record: WorkRecord): void {
    log.append(record);
    kankakuCommand.invalidateClientNames();
  }

  function buildRecord(core: WorkRecordCore, ctx: ExtensionContext): WorkRecord {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
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
      ...(client !== undefined ? { client } : {}),
      ...(sessionName !== undefined ? { sessionName } : {}),
      ...(sessionDir !== undefined ? { sessionDir } : {}),
      ...(target !== undefined
        ? {
            clientId: target.clientId,
            clientName: target.clientName,
            ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
            ...(target.projectName !== undefined ? { projectName: target.projectName } : {}),
          }
        : {}),
      ...(deps.machine !== undefined ? { machine: deps.machine } : {}),
      ...(roleConfidence !== undefined ? { roleConfidence } : {}),
      ...(deps.orchestratorRef !== undefined ? { orchestratorRef: deps.orchestratorRef } : {}),
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
      const core = tracker.onSettled();
      try {
        if (core) {
          appendRecord(buildRecord(core, ctx));
        }
      } finally {
        // Always clean up, even when appendRecord above threw: an unpersisted
        // checkpoint must not linger, and the status timer must not leak.
        inflight.clear();
        statusBar.stop(ctx);
        sessionClient.endRun();
        deps.sessionTarget?.endRun();
        triggerAutoSync(ctx, "agent_settled");
      }
    }),
  );

  pi.on(
    "session_shutdown",
    guarded((_event, ctx) => {
      const core = tracker.onShutdown();
      try {
        if (core) {
          appendRecord(buildRecord(core, ctx));
        }
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
