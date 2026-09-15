import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { isValidClient, resolveClient, resolveClientSource } from "../domain/client-label.ts";
import { exportRows, toCsv, toJson } from "../domain/export.ts";
import { WorkTracker } from "../domain/work-tracker.ts";
import { buildSessions, buildTasks } from "../domain/task-view.ts";
import type { WorkRecord, WorkRecordCore, WorkRole } from "../domain/work-record.ts";
import type { InflightStore } from "../ports/inflight-store.ts";
import type { WorkLog } from "../ports/work-log.ts";
import { formatClients, formatReport, formatSessions, formatTasks, localDay, summarize, summarizeByClient } from "./report.ts";

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

/** Persisted as a `kankaku-client` custom session entry so the session-level client survives a reload. */
interface KankakuClientEntryData {
  client: string | undefined;
}

const CLIENT_ENTRY_TYPE = "kankaku-client";

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

const STATUS_KEY = "kankaku";
const REPORT_ENTRY_TYPE = "kankaku-report";

/** Durable report rendered inside the chat transcript; never sent to the LLM. */
export interface KankakuReportData {
  title: string;
  lines: string[];
}

function formatElapsed(ms: number, client?: string): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const elapsed = `🕒 ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return client ? `${elapsed} · ${client}` : elapsed;
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
  const { tracker, log, inflight, role, pid, parentPid } = deps;
  const statusIntervalMs = deps.statusIntervalMs ?? 1000;
  const isAlive = deps.isAlive ?? defaultIsAlive;

  let runStartedAt: number | undefined;
  let statusTimer: NodeJS.Timeout | undefined;
  /** Session-level client override, set with `/kankaku client <name>` and restored on `session_start`. Highest precedence in `resolveClient`. */
  let sessionClient: string | undefined;
  /** Project client read once per run (first record build) so checkpoints do not hit the filesystem repeatedly. */
  let runProjectClient: { value: string | undefined } | undefined;

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
    const client = role === "orchestrator" ? resolveClient(runClientSources()) : undefined;
    ctx.ui.setStatus(STATUS_KEY, formatElapsed(0, client));
    statusTimer = setInterval(() => {
      if (runStartedAt === undefined) return;
      ctx.ui.setStatus(STATUS_KEY, formatElapsed(Date.now() - runStartedAt, client));
    }, statusIntervalMs);
    statusTimer.unref?.();
  }

  /**
   * Scan the session's entries for the last `kankaku-client` custom entry
   * and return the client it recorded (`undefined` when that entry cleared
   * the label, or when no such entry exists yet).
   */
  function restoreSessionClient(ctx: ExtensionContext): string | undefined {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as { type: string; customType?: string; data?: unknown };
      if (entry.type === "custom" && entry.customType === CLIENT_ENTRY_TYPE) {
        const data = entry.data as KankakuClientEntryData | undefined;
        return data?.client;
      }
    }
    return undefined;
  }

  function clientSources(project: string | undefined = deps.resolveProjectClient?.()): { session?: string; env?: string; project?: string } {
    return {
      session: sessionClient,
      env: deps.envClient,
      project,
    };
  }

  function runClientSources(): ReturnType<typeof clientSources> {
    if (!runProjectClient) {
      runProjectClient = { value: deps.resolveProjectClient?.() };
    }
    return clientSources(runProjectClient.value);
  }

  function buildRecord(core: WorkRecordCore, ctx: ExtensionContext): WorkRecord {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    // Subagent children never carry their own client: they inherit the
    // orchestrator's label at task level (see task-view.ts).
    const client = role === "orchestrator" ? resolveClient(runClientSources()) : undefined;
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
          log.append(buildRecord(core, ctx));
        }
      } finally {
        // Always clean up, even when log.append above threw: an unpersisted
        // checkpoint must not linger, and the status timer must not leak.
        inflight.clear();
        stopStatus(ctx);
        runProjectClient = undefined;
      }
    }),
  );

  pi.on(
    "session_shutdown",
    guarded((_event, ctx) => {
      const core = tracker.onShutdown();
      try {
        if (core) {
          log.append(buildRecord(core, ctx));
        }
      } finally {
        inflight.clear();
        stopStatus(ctx);
        runProjectClient = undefined;
      }
    }),
  );

  pi.on(
    "session_start",
    guarded((_event, ctx) => {
      sessionClient = restoreSessionClient(ctx);

      const recovered = inflight.recoverStale(isAlive);
      for (const record of recovered) {
        log.append(record);
      }
      if (recovered.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`kankaku: recovered ${recovered.length} interrupted record(s)`, "warning");
      }
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

  /** Handle `/kankaku client [<name> | --clear]`; `rest` excludes the leading `client` token. */
  function handleClientCommand(rest: string[], ctx: ExtensionContext): void {
    if (rest.length === 1 && rest[0] === "--clear") {
      sessionClient = undefined;
      pi.appendEntry<KankakuClientEntryData>(CLIENT_ENTRY_TYPE, { client: undefined });
      showReport(ctx, { title: "client", lines: ["client label cleared for this session"] });
      return;
    }

    if (rest.length === 0) {
      const sources = clientSources();
      const client = resolveClient(sources);
      const source = resolveClientSource(sources);
      const line = client !== undefined ? `client: ${client} (from ${source})` : "client: none";
      showReport(ctx, { title: "client", lines: [line] });
      return;
    }

    const name = rest.join(" ");
    if (!isValidClient(name)) {
      notifyError(ctx, new Error(`invalid client name: ${name}`));
      return;
    }
    sessionClient = name;
    pi.appendEntry<KankakuClientEntryData>(CLIENT_ENTRY_TYPE, { client: name });
    showReport(ctx, { title: "client", lines: [`client set to ${name}`] });
  }

  /** Handle `/kankaku export [csv|json] [all]`; `rest` excludes the leading `export` token. Default format is csv. */
  function handleExportCommand(rest: string[], ctx: ExtensionContext): void {
    if (!deps.writeExportFile) {
      notifyError(ctx, new Error("export is not configured"));
      return;
    }

    const all = rest.includes("all");
    const format: "csv" | "json" = rest.includes("json") ? "json" : "csv";
    const records = log.readAll();
    const today = localDay(new Date().toISOString());
    const tasks = buildTasks(records).filter((task) => all || localDay(task.startedAt) === today);
    const rows = exportRows(tasks);
    const content = format === "json" ? toJson(rows) : toCsv(rows);
    const name = `tasks-${all ? "all" : today}.${format}`;
    const path = deps.writeExportFile(name, content);
    showReport(ctx, { title: "export", lines: [`wrote ${rows.length} row(s) to ${path}`] });
  }

  const COMMAND_TOKENS = ["all", "tasks", "sessions", "client", "clients", "export"];

  pi.registerCommand("kankaku", {
    description:
      "Show kankaku work-time totals for today. Args (any order): 'all' for every record, " +
      "'tasks' for this session's tasks ('tasks all' for every session), 'sessions' for today's sessions, " +
      "'client <name>' to set the session billing client, 'client' to show the effective one and its source, " +
      "'client --clear' to clear it, 'clients' for per-client totals today ('clients all' for every day), " +
      "'export [csv|json] [all]' to write today's (or every) task as a file.",
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] => {
      const clientMatch = /^client\s+(\S*)$/.exec(argumentPrefix);
      if (clientMatch) {
        const prefix = clientMatch[1] ?? "";
        const names = Array.from(
          new Set(
            log
              .readAll()
              .map((record) => record.client)
              .filter((client): client is string => typeof client === "string"),
          ),
        ).sort();
        return names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
      }
      return COMMAND_TOKENS.filter((value) => value.startsWith(argumentPrefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);

        if (tokens[0] === "client") {
          handleClientCommand(tokens.slice(1), ctx);
          return;
        }

        if (tokens[0] === "export") {
          handleExportCommand(tokens.slice(1), ctx);
          return;
        }

        const all = tokens.includes("all");
        const records = log.readAll();
        const today = localDay(new Date().toISOString());

        if (tokens.includes("clients")) {
          const tasks = buildTasks(records).filter((task) => all || localDay(task.startedAt) === today);
          showReport(ctx, {
            title: all ? "clients (all days)" : "clients (today)",
            lines: formatClients(summarizeByClient(tasks)).split("\n"),
          });
          return;
        }

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
