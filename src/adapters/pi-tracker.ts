import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { WorkTracker } from "../domain/work-tracker.ts";
import { buildSessions, buildTasks } from "../domain/task-view.ts";
import type { WorkRecord, WorkRole } from "../domain/work-record.ts";
import type { WorkLog } from "../ports/work-log.ts";
import { formatReport, formatSessions, formatTasks, localDay, summarize } from "./report.ts";

export interface PiTrackerDeps {
  tracker: WorkTracker;
  log: WorkLog;
  role: WorkRole;
  pid: number;
  parentPid: number;
  /** Status line refresh interval in ms. Defaults to 1000. */
  statusIntervalMs?: number;
}

const STATUS_KEY = "kankaku";
const REPORT_ENTRY_TYPE = "kankaku-report";

/** Durable report rendered inside the chat transcript; never sent to the LLM. */
export interface KankakuReportData {
  title: string;
  lines: string[];
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `⏱ ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function notifyError(ctx: ExtensionContext, error: unknown): void {
  if (!ctx.hasUI) return;
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`kankaku: ${message}`, "error");
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
  const { tracker, log, role, pid, parentPid } = deps;
  const statusIntervalMs = deps.statusIntervalMs ?? 1000;

  let runStartedAt: number | undefined;
  let statusTimer: NodeJS.Timeout | undefined;

  function stopStatus(ctx: ExtensionContext): void {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    runStartedAt = undefined;
  }

  function startStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    runStartedAt = Date.now();
    ctx.ui.setStatus(STATUS_KEY, formatElapsed(0));
    statusTimer = setInterval(() => {
      if (runStartedAt === undefined) return;
      ctx.ui.setStatus(STATUS_KEY, formatElapsed(Date.now() - runStartedAt));
    }, statusIntervalMs);
    statusTimer.unref?.();
  }

  function buildRecord(core: NonNullable<ReturnType<WorkTracker["onSettled"]>>, ctx: ExtensionContext): WorkRecord {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
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
    };
  }

  pi.on(
    "before_agent_start",
    guarded((event, ctx) => {
      tracker.onRunStart(event.prompt);
      if (runStartedAt === undefined) startStatus(ctx);
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
    guarded((event) => {
      const message = event.message;
      const usage = message && "usage" in message ? message.usage : undefined;
      tracker.onTurnEnd(
        usage
          ? {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              cost: usage.cost.total,
            }
          : undefined,
      );
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
    guarded((event) => {
      tracker.onToolEnd(event.toolCallId, event.result);
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
      if (core) {
        log.append(buildRecord(core, ctx));
      }
      stopStatus(ctx);
    }),
  );

  pi.on(
    "session_shutdown",
    guarded((_event, ctx) => {
      const core = tracker.onShutdown();
      if (core) {
        log.append(buildRecord(core, ctx));
      }
      stopStatus(ctx);
    }),
  );

  pi.registerEntryRenderer<KankakuReportData>(REPORT_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data ?? { title: "kankaku", lines: [] };
    const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${theme.fg("accent", "kankaku")} ${data.title}`, 0, 0));
    for (const line of data.lines) {
      box.addChild(new Text(line, 0, 0));
    }
    return box;
  });

  function showReport(ctx: ExtensionContext, report: KankakuReportData): void {
    if (ctx.hasUI) {
      pi.appendEntry<KankakuReportData>(REPORT_ENTRY_TYPE, report);
      return;
    }
    ctx.ui.notify(`${report.title}\n${report.lines.join("\n")}`);
  }

  pi.registerCommand("kankaku", {
    description:
      "Show kankaku work-time totals for today. Args (any order): 'all' for every record, " +
      "'tasks' for this session's tasks ('tasks all' for every session), 'sessions' for today's sessions.",
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const all = tokens.includes("all");
        const records = log.readAll();
        const today = localDay(new Date().toISOString());

        if (tokens.includes("tasks")) {
          const sessionId = ctx.sessionManager.getSessionId();
          const scoped = all || !sessionId;
          const tasks = buildTasks(records).filter((task) => scoped || task.sessionId === sessionId);
          showReport(ctx, {
            title: scoped ? "tasks (every session)" : "tasks (this session)",
            lines: formatTasks(tasks).split("\n"),
          });
          return;
        }

        if (tokens.includes("sessions")) {
          const tasks = buildTasks(records).filter((task) => all || localDay(task.startedAt) === today);
          showReport(ctx, {
            title: all ? "sessions (all days)" : "sessions (today)",
            lines: formatSessions(buildSessions(tasks)).split("\n"),
          });
          return;
        }

        const summary = summarize(records, { all });
        showReport(ctx, {
          title: all ? "summary (all days)" : "summary (today)",
          lines: formatReport(summary).split(" | "),
        });
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });
}
