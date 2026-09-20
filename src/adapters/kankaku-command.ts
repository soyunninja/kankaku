import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { isValidClient } from "../domain/client-label.ts";
import { exportRows, toCsv, toJson } from "../domain/export.ts";
import { buildSessions, buildTasks } from "../domain/task-view.ts";
import { formatWorkTargetLabel } from "../domain/work-target.ts";
import type { SyncState } from "../domain/sync-plan.ts";
import type { Catalog } from "../ports/catalog.ts";
import type { WorkLog } from "../ports/work-log.ts";
import type { SyncSummary, SyncTrigger } from "./sync-runner.ts";
import {
  formatClients,
  formatProjects,
  formatReport,
  formatSessions,
  formatTasks,
  localDay,
  summarize,
  summarizeByClient,
  summarizeByProject,
} from "./report.ts";
import type { SessionClient } from "./session-client.ts";
import type { SessionTarget } from "./session-target.ts";

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
/** Only offered when the hub is configured, so completions are unchanged for users without one. */
const HUB_COMMAND_TOKENS = ["target", "projects", "catalog", "sync", "backfill"];
const TARGET_TOKENS = ["pick", "clear"];
const CATALOG_TOKENS = ["refresh"];
const SYNC_TOKENS = ["all", "status"];

/** Drives `/kankaku sync [all|status]` and `/kankaku backfill`. Present only when the hub is configured. */
export interface SyncCommandDeps {
  /**
   * Run one sync pass; `full: true` re-evaluates every task (`/kankaku
   * sync all`, `/kankaku backfill`). `trigger`, left unset here (a manual
   * command), marks the automatic `session_start`/`agent_settled` path
   * (`pi-tracker.ts`) so its version short-circuit and throttle never
   * apply to a manual sync. Never throws.
   */
  run: (options?: { full?: boolean; trigger?: SyncTrigger }) => Promise<SyncSummary>;
  /** `/kankaku sync status`: the persisted state plus a locally-computed pending count. No network. */
  status: () => { state: SyncState | undefined; pending: number };
}

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
  /**
   * Present only when the hub (PocketBase) is configured. Drives `/kankaku
   * target [pick|clear]` and makes `/kankaku client <name>` validate
   * against the catalog instead of accepting free text.
   */
  sessionTarget?: SessionTarget;
  /** Present only when the hub is configured. Drives `/kankaku catalog refresh` and the hub-aware `/kankaku client <name>`. */
  catalog?: Catalog;
  /** Present only when the hub is configured. Drives `/kankaku sync [all|status]` and `/kankaku backfill`. */
  sync?: SyncCommandDeps;
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

  /**
   * Handle `/kankaku client [<name> | --clear]`; `rest` excludes the
   * leading `client` token. When the hub is configured, setting a name
   * (not `--clear` or empty) is the legacy compatibility path: it
   * validates against the catalog (case-insensitive exact match of a
   * client `code` or `name`) and sets the session hub target with no
   * project, instead of the free-text legacy client. `--clear` and the
   * no-argument report stay on the legacy client for both cases.
   */
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

    if (deps.sessionTarget) {
      const clients = (deps.catalog?.read()?.clients ?? []).filter((client) => client.active && !client.unassigned);
      const lowerName = name.toLowerCase();
      const match = clients.find((client) => client.code.toLowerCase() === lowerName || client.name.toLowerCase() === lowerName);
      if (!match) {
        const validCodes = clients
          .map((client) => client.code)
          .sort()
          .join(", ");
        notifyError(ctx, new Error(`unknown client: ${name}${validCodes ? ` (valid: ${validCodes})` : ""}`));
        return;
      }
      deps.sessionTarget.setExplicit(pi, { clientId: match.id });
      deps.refreshIdleStatus(ctx);
      showReport(ctx, { title: "client", lines: [`client set to ${match.name} (${match.code})`] });
      return;
    }

    if (!isValidClient(name)) {
      notifyError(ctx, new Error(`invalid client name: ${name}`));
      return;
    }
    sessionClient.set(pi, name);
    deps.refreshIdleStatus(ctx);
    showReport(ctx, { title: "client", lines: [`client set to ${name}`] });
  }

  /** Handle `/kankaku target [pick|clear]`; `rest` excludes the leading `target` token. */
  async function handleTargetCommand(rest: string[], ctx: ExtensionContext): Promise<void> {
    const sessionTarget = deps.sessionTarget;
    if (!sessionTarget) {
      notifyError(ctx, new Error("hub is not configured"));
      return;
    }

    if (rest.length === 1 && rest[0] === "clear") {
      sessionTarget.clear(pi);
      deps.refreshIdleStatus(ctx);
      showReport(ctx, { title: "target", lines: ["target cleared for this session"] });
      return;
    }

    if (rest.length === 1 && rest[0] === "pick") {
      await sessionTarget.pick(pi, ctx);
      deps.refreshIdleStatus(ctx);
      const target = sessionTarget.effectiveTarget();
      const line = target ? `target set to ${formatWorkTargetLabel(target)}` : "target skipped";
      showReport(ctx, { title: "target", lines: [line] });
      return;
    }

    if (rest.length === 0) {
      const target = sessionTarget.effectiveTarget();
      const source = sessionTarget.effectiveSource();
      const line = target !== undefined ? `target: ${formatWorkTargetLabel(target)} (from ${source})` : "target: none";
      showReport(ctx, { title: "target", lines: [line] });
      return;
    }

    notifyError(ctx, new Error(`unknown target subcommand: ${rest.join(" ")}`));
  }

  /** Handle `/kankaku catalog refresh`; `rest` excludes the leading `catalog` token. */
  async function handleCatalogCommand(rest: string[], ctx: ExtensionContext): Promise<void> {
    const catalog = deps.catalog;
    if (!catalog) {
      notifyError(ctx, new Error("hub is not configured"));
      return;
    }

    if (rest.length === 1 && rest[0] === "refresh") {
      const snapshot = await catalog.refresh();
      if (!snapshot) {
        notifyError(ctx, new Error("hub unreachable; catalog not refreshed"));
        return;
      }
      showReport(ctx, {
        title: "catalog",
        lines: [`refreshed: ${snapshot.clients.length} client(s), ${snapshot.projects.length} project(s)`],
      });
      return;
    }

    notifyError(ctx, new Error(`unknown catalog subcommand: ${rest.join(" ")}`));
  }

  /** Render a {@link SyncSummary} as report lines: counts, any stop reason, the new watermark, and the unassigned breakdown. */
  function formatSyncSummary(summary: SyncSummary): string[] {
    const lines = [`uploaded ${summary.uploaded}, updated ${summary.updated}, skipped ${summary.skipped}, failed ${summary.failed.length}`];

    if (summary.locked) lines.push("another sync is already in progress; nothing was attempted");
    if (summary.error) lines.push(`stopped early: ${summary.error}`);
    if (summary.syncedThrough) lines.push(`synced through ${summary.syncedThrough}`);

    const unassignedEntries = Object.entries(summary.unassigned).sort(([a], [b]) => a.localeCompare(b));
    if (unassignedEntries.length > 0) {
      lines.push("unassigned (Sin determinar):");
      for (const [label, count] of unassignedEntries) lines.push(`  ${label}: ${count}`);
    }

    if (summary.failed.length > 0) {
      lines.push("failed:");
      for (const entry of summary.failed) lines.push(`  ${entry.id}: ${entry.reason}`);
    }

    return lines;
  }

  /** Handle `/kankaku sync [all|status]`; `rest` excludes the leading `sync` token. */
  async function handleSyncCommand(rest: string[], ctx: ExtensionContext): Promise<void> {
    const sync = deps.sync;
    if (!sync) {
      notifyError(ctx, new Error("hub is not configured"));
      return;
    }

    if (rest.length === 1 && rest[0] === "status") {
      const { state, pending } = sync.status();
      const lines = [state?.syncedThrough ? `synced through ${state.syncedThrough}` : "never synced", `pending: ${pending}`];
      if (state?.lastError) lines.push(`last error: ${state.lastError.message} (at ${state.lastError.at})`);
      showReport(ctx, { title: "sync status", lines });
      return;
    }

    if (rest.length > 0 && !(rest.length === 1 && rest[0] === "all")) {
      notifyError(ctx, new Error(`unknown sync subcommand: ${rest.join(" ")}`));
      return;
    }

    const full = rest[0] === "all";
    const summary = await sync.run({ full });
    showReport(ctx, { title: full ? "sync (all)" : "sync", lines: formatSyncSummary(summary) });
  }

  /** Handle `/kankaku backfill`: a full sync, reported as the "Sin determinar" breakdown that needs reassigning in the web. */
  async function handleBackfillCommand(ctx: ExtensionContext): Promise<void> {
    const sync = deps.sync;
    if (!sync) {
      notifyError(ctx, new Error("hub is not configured"));
      return;
    }

    const summary = await sync.run({ full: true });
    const unassignedEntries = Object.entries(summary.unassigned).sort(([a], [b]) => a.localeCompare(b));

    const lines =
      unassignedEntries.length > 0
        ? [
            ...unassignedEntries.map(([label, count]) => `${label}: ${count} task(s) -> Sin determinar`),
            "reassign these in the hub web app's unassigned queue",
          ]
        : ["no unassigned tasks"];

    if (summary.error) lines.push(`stopped early: ${summary.error}`);
    showReport(ctx, { title: "backfill", lines });
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
      "'export [csv|json] [all]' to write today's (or every) task as a file. " +
      "When a hub (PocketBase) is configured: 'target' to show the effective client/project and its source, " +
      "'target pick' to run the picker again, 'target clear' to clear the session target, " +
      "'catalog refresh' to force a catalog refresh, 'projects' for per-project totals today ('projects all' for every day), " +
      "'sync' to push pending tasks to the hub ('sync all' for a full re-evaluation, 'sync status' for the watermark/pending count/last error), " +
      "'backfill' to run a full sync and report how many tasks went to Sin determinar, grouped by their old label. " +
      "With a hub configured, 'client <name>' instead validates against the catalog (code or name) and sets the target.",
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] => {
      const clientMatch = /^client\s+(\S*)$/.exec(argumentPrefix);
      if (clientMatch) {
        const prefix = clientMatch[1] ?? "";
        return clientNames()
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ value: name, label: name }));
      }
      const targetMatch = /^target\s+(\S*)$/.exec(argumentPrefix);
      if (targetMatch) {
        const prefix = targetMatch[1] ?? "";
        return TARGET_TOKENS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      }
      const catalogMatch = /^catalog\s+(\S*)$/.exec(argumentPrefix);
      if (catalogMatch) {
        const prefix = catalogMatch[1] ?? "";
        return CATALOG_TOKENS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      }
      const syncMatch = /^sync\s+(\S*)$/.exec(argumentPrefix);
      if (syncMatch) {
        const prefix = syncMatch[1] ?? "";
        return SYNC_TOKENS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      }
      const tokens = deps.sessionTarget ? [...COMMAND_TOKENS, ...HUB_COMMAND_TOKENS] : COMMAND_TOKENS;
      return tokens.filter((value) => value.startsWith(argumentPrefix)).map((value) => ({ value, label: value }));
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

        if (tokens[0] === "target") {
          await handleTargetCommand(tokens.slice(1), ctx);
          return;
        }

        if (tokens[0] === "catalog") {
          await handleCatalogCommand(tokens.slice(1), ctx);
          return;
        }

        if (tokens[0] === "sync") {
          await handleSyncCommand(tokens.slice(1), ctx);
          return;
        }

        if (tokens[0] === "backfill") {
          await handleBackfillCommand(ctx);
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

        if (tokens.includes("projects")) {
          const tasks = buildTasks(records).filter((task) => all || localDay(task.startedAt) === today);
          showReport(ctx, {
            title: all ? "projects (all days)" : "projects (today)",
            lines: formatProjects(summarizeByProject(tasks)).split("\n"),
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
