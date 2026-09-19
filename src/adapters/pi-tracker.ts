import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkRecord, WorkRecordCore, WorkRole } from "../domain/work-record.ts";
import type { WorkTracker } from "../domain/work-tracker.ts";
import type { InflightStore } from "../ports/inflight-store.ts";
import type { WorkLog } from "../ports/work-log.ts";
import { createSessionClient } from "./session-client.ts";
import { createStatusBar } from "./status-bar.ts";
import { notifyError, registerKankakuCommand } from "./kankaku-command.ts";

export type { KankakuReportData } from "./kankaku-command.ts";

export interface PiTrackerDeps {
  tracker: WorkTracker;
  log: WorkLog;
  /** Crash-recovery checkpoint store; see the "Crash recovery" README section. */
  inflight: InflightStore;
  role: WorkRole;
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

/**
 * Wires pi lifecycle events to a {@link WorkTracker}, persisting finished
 * records to a {@link WorkLog} and exposing the `/kankaku` report command.
 */
export function createPiTracker(pi: ExtensionAPI, deps: PiTrackerDeps): void {
  const { tracker, log, inflight, role, pid, parentPid } = deps;
  const isAlive = deps.isAlive ?? defaultIsAlive;

  const sessionClient = createSessionClient({
    role,
    envClient: deps.envClient,
    resolveProjectClient: deps.resolveProjectClient,
  });

  const statusBar = createStatusBar({
    intervalMs: deps.statusIntervalMs,
    resolveRunClient: () => sessionClient.runClient(),
    resolveIdleClient: () => sessionClient.idleClient(),
  });

  const kankakuCommand = registerKankakuCommand(pi, {
    log,
    sessionClient,
    refreshIdleStatus: (ctx) => statusBar.showIdle(ctx),
    writeExportFile: deps.writeExportFile,
  });

  /** `log.append` plus cache invalidation, so every append this process makes keeps the completion cache correct. */
  function appendRecord(record: WorkRecord): void {
    log.append(record);
    kankakuCommand.invalidateClientNames();
  }

  function buildRecord(core: WorkRecordCore, ctx: ExtensionContext): WorkRecord {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    // Subagent children never carry their own client: they inherit the
    // orchestrator's label at task level (see task-view.ts).
    const client = sessionClient.runClient();
    const sessionName = pi.getSessionName();
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
      }
    }),
  );

  pi.on(
    "session_start",
    guarded((_event, ctx) => {
      sessionClient.restore(ctx);
      statusBar.showIdle(ctx);

      const recovered = inflight.recoverStale(isAlive);
      for (const record of recovered) {
        appendRecord(record);
      }
      if (recovered.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`kankaku: recovered ${recovered.length} interrupted record(s)`, "warning");
      }
    }),
  );
}
