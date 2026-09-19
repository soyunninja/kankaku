import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { isValidClient } from "../domain/client-label.ts";
import { exportRows, toCsv, toJson } from "../domain/export.ts";
import { buildSessions, buildTasks } from "../domain/task-view.ts";
import type { WorkLog } from "../ports/work-log.ts";
import { formatClients, formatReport, formatSessions, formatTasks, localDay, summarize, summarizeByClient } from "./report.ts";
import type { SessionClient } from "./session-client.ts";

const REPORT_ENTRY_TYPE = "kankaku-report";

/** Durable report rendered inside the chat transcript; never sent to the LLM. */
export interface KankakuReportData {
  title: string;
  lines: string[];
}

/** Notify the user of an error through the UI, when one is available. */
export function notifyError(ctx: ExtensionContext, error: unknown): void {
  if (!ctx.hasUI) return;
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`kankaku: ${message}`, "error");
}

const COMMAND_TOKENS = ["all", "tasks", "sessions", "client", "clients", "export"];

export interface KankakuCommandDeps {
  log: WorkLog;
  sessionClient: SessionClient;
  /** Refresh the idle status line, e.g. after `/kankaku client` changes the session client. */
  refreshIdleStatus: (ctx: ExtensionContext) => void;
  /**
   * Write an export file (name, content) under the kankaku dir and return
   * its absolute path. `/kankaku export` notifies an error when this is not
   * configured.
   */
  writeExportFile?: (name: string, content: string) => string;
}

export interface KankakuCommand {
  /** Drop the cached client-name list so the next completion re-reads the log. */
  invalidateClientNames(): void;
}

/**
 * Registers the `/kankaku` command (report/tasks/sessions/clients/export/
 * client), its argument completions, and the durable report entry renderer.
 */
export function registerKankakuCommand(pi: ExtensionAPI, deps: KankakuCommandDeps): KankakuCommand {
  const { log, sessionClient } = deps;

  /**
   * Cached, sorted, de-duplicated client names for `/kankaku client <prefix>`
   * autocomplete, so pressing a key does not re-read the whole worklog.
   * Invalidated whenever this process appends a record, and — when `log`
   * exposes the optional `version()` signal — whenever that signal changes,
   * so a change from another process is picked up too.
   */
  let clientNamesCache: string[] | undefined;
  let clientNamesCacheVersion: string | number | undefined;

  function invalidateClientNames(): void {
    clientNamesCache = undefined;
  }

  function clientNames(): string[] {
    const currentVersion = log.version?.();
    const versionUnchanged = log.version === undefined || currentVersion === clientNamesCacheVersion;
    if (clientNamesCache !== undefined && versionUnchanged) {
      return clientNamesCache;
    }
    const names = Array.from(
      new Set(
        log
          .readAll()
          .map((record) => record.client)
          .filter((client): client is string => typeof client === "string"),
      ),
    ).sort();
    clientNamesCache = names;
    clientNamesCacheVersion = currentVersion;
    return names;
  }

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
      sessionClient.set(pi, undefined);
      deps.refreshIdleStatus(ctx);
      showReport(ctx, { title: "client", lines: ["client label cleared for this session"] });
      return;
    }

    if (rest.length === 0) {
      const client = sessionClient.effectiveClient();
      const source = sessionClient.effectiveSource();
      const line = client !== undefined ? `client: ${client} (from ${source})` : "client: none";
      showReport(ctx, { title: "client", lines: [line] });
      return;
    }

    const name = rest.join(" ");
    if (!isValidClient(name)) {
      notifyError(ctx, new Error(`invalid client name: ${name}`));
      return;
    }
    sessionClient.set(pi, name);
    deps.refreshIdleStatus(ctx);
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
        return clientNames()
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ value: name, label: name }));
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

  return { invalidateClientNames };
}
