import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { isValidClient } from "../domain/client-label.ts";
import { exportRows, toCsv, toJson } from "../domain/export.ts";
import { buildSessions, buildTasks, detectSameProcessOverlaps, orphanSubagents, uncertainRecords } from "../domain/task-view.ts";
import { formatWorkTargetLabel } from "../domain/work-target.ts";
import { findAmbiguousToolNames } from "../domain/subagent-profile.ts";
import type { SubagentProfile } from "../domain/subagent-profile.ts";
import type { RejectedChildEnvMarker } from "../config.ts";
import type { SyncState } from "../domain/sync-plan.ts";
import type { RegistryClassification } from "../domain/registry-health.ts";
import type { Catalog } from "../ports/catalog.ts";
import type { WorkLog } from "../ports/work-log.ts";
import type { SyncSummary, SyncTrigger } from "./sync-runner.ts";
import {
  countUncertain,
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
import { readNonDefaultSessionDir } from "./session-dir.ts";
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

const COMMAND_TOKENS = ["all", "tasks", "sessions", "client", "clients", "export", "doctor"];
/** Only offered when the hub is configured, so completions are unchanged for users without one. */
const HUB_COMMAND_TOKENS = ["target", "task", "projects", "catalog", "sync", "backfill"];
const TARGET_TOKENS = ["pick", "clear"];
const TASK_TOKENS = ["pick", "clear"];
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
  /**
   * `/kankaku sync status`: the persisted state, a locally-computed pending
   * count, and (R3) how many tasks changed since their last sync but fall
   * outside this run's revisit window — needs `sync all`. No network.
   */
  status: () => { state: SyncState | undefined; pending: number; staleOutsideWindow: number };
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
  /**
   * Read-only machine-wide process-registry health snapshot (see
   * `adapters/machine-process-registry.ts#health`), for `/kankaku doctor`
   * (SUBAGENT-REQ-017): how many entries would be kept vs discarded, and
   * why. Absent entirely when the registry is unavailable for some reason
   * kankaku itself could not construct (never expected in practice, since
   * `MachineProcessRegistry` always degrades gracefully on its own) —
   * doctor then simply omits that section rather than guessing.
   */
  registryHealth?: () => RegistryClassification;
  /**
   * Whether the OS ancestor-chain mechanism itself is actually usable right
   * now (F2): `false` on a platform with no supported mechanism (Windows)
   * *or* when the mechanism is available but a fresh attempt still fails
   * (`ps`/`/proc` missing, timing out, or producing unreadable output) —
   * both collapse to the same "could not check" state, distinct from
   * "checked, no tracked ancestor found". Never folded into
   * `WorkRecord.roleConfidence`: an unprovable ancestor never demotes a
   * process to `uncertain` (see `config.ts#detectRole`'s doc comment) — this
   * is purely a visibility signal for the doctor's own report. Falls back
   * to a bare `process.platform !== "win32"` check when not provided
   * (back-compat with a caller that has not wired the real, ps/proc-aware
   * check yet).
   */
  ancestorDetectionAvailable?: () => boolean;
  /**
   * `KANKAKU_ROLE`, when it held a recognised value for this process (F3's
   * explicit escape hatch) — reported by doctor as the deciding signal for
   * this process's role, UNLESS `childMarkerPresent` or
   * `overrideIgnoredInteractive` below says otherwise (R1): the override no
   * longer beats every other detection signal unconditionally.
   */
  roleOverride?: "orchestrator" | "subagent";
  /**
   * Whether `GENTLE_PI_AGENTS_CHILD=1` (the confirmed child marker) was
   * also present on this process (R1) — when both it and `roleOverride`
   * are set, the marker always wins (`config.ts#detectRole`'s precedence),
   * so doctor flags the contradiction with the resolved outcome instead of
   * claiming the override decided anything.
   */
  childMarkerPresent?: boolean;
  /**
   * Set when `KANKAKU_ROLE=subagent` was present, with no confirmed child
   * marker, but was ignored because this process looked interactive (R1) —
   * doctor reports the resolved outcome (orchestrator) instead of claiming
   * the override decided this process's role.
   */
  overrideIgnoredInteractive?: boolean;
  /**
   * C2 (CRITICAL fix): set when a USER-CONFIGURED child-env marker
   * (`KANKAKU_SUBAGENT_CHILD_ENV`) matched, but was ignored because this
   * process looked interactive — a configured marker, unlike a built-in
   * one, never demotes an interactive session. Doctor escalates the
   * wording when `hasTrackedAncestor` is also `false` (C2 item 3's
   * self-check: the strongest signal the marker is genuinely ambient).
   */
  configuredMarkerIgnoredInteractive?: boolean;
  /** C2 item 3: whether a live tracked ancestor was found for this process — see `configuredMarkerIgnoredInteractive` above. */
  hasTrackedAncestor?: boolean;
  /**
   * C2 (CRITICAL fix, item 1): every `KANKAKU_SUBAGENT_CHILD_ENV` marker
   * `config.ts#validateSubagentChildEnvMarkers` rejected as looking
   * pi/shell/OS/npm-owned rather than genuinely child-only.
   */
  rejectedSubagentChildEnvMarkers?: RejectedChildEnvMarker[];
  /**
   * Set only when this process is itself a subagent whose work log/inflight
   * checkpoints were routed to its orchestrator's kankaku directory (F1, ADR
   * 0023's rewrite): `usedFallback: true` means the orchestrator's
   * directory could not be written to (gone, or no permission) and this
   * process fell back to its own local directory instead — surfaced here so
   * a human can notice and go reunite the record manually, since the
   * append-only log can never be rewritten to fix it after the fact.
   */
  workLogRouting?: { usedFallback: boolean; parentDir: string };
  /**
   * The full active {@link SubagentProfile} set (`config.ts#loadConfig`'s
   * `subagentProfiles`), for `/kankaku doctor` (SUBAGENT-REQ-001/002/003/005/017):
   * which profiles are active, any configured tool names/child-env markers,
   * which profile matched each subagent record, and any tool-name ambiguity
   * among the active set. Omitted entirely (no profile section at all) when
   * a caller has not wired this — back-compat with an older embedder.
   */
  subagentProfiles?: SubagentProfile[];
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

  /**
   * Handle `/kankaku task [pick|clear]`; `rest` excludes the leading `task`
   * token. Default (no args) is `pick`. `pickTask`/`clearTask`
   * (`session-target.ts`) notify their own outcome directly, so this only
   * dispatches and refreshes the idle status line.
   */
  async function handleTaskCommand(rest: string[], ctx: ExtensionContext): Promise<void> {
    const sessionTarget = deps.sessionTarget;
    if (!sessionTarget) {
      notifyError(ctx, new Error("hub is not configured"));
      return;
    }

    if (rest.length === 1 && rest[0] === "clear") {
      sessionTarget.clearTask(pi);
      deps.refreshIdleStatus(ctx);
      showReport(ctx, { title: "task", lines: ["task link cleared for this session"] });
      return;
    }

    if (rest.length === 0 || (rest.length === 1 && rest[0] === "pick")) {
      await sessionTarget.pickTask(pi, ctx);
      deps.refreshIdleStatus(ctx);
      return;
    }

    notifyError(ctx, new Error(`unknown task subcommand: ${rest.join(" ")}`));
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
      const { state, pending, staleOutsideWindow } = sync.status();
      const lines = [state?.syncedThrough ? `synced through ${state.syncedThrough}` : "never synced", `pending: ${pending}`];
      if (staleOutsideWindow > 0) {
        lines.push(`${staleOutsideWindow} task(s) never synced fall outside the sync window — run '/kankaku sync all' to upload them`);
      }
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

  /**
   * Handle `/kankaku doctor`: a no-network diagnostic (SUBAGENT-REQ-017)
   * reporting orphan/uncertain record counts (ADR 0022) with why, and
   * whether ancestor-chain detection is available on this platform, so
   * silent undercount stays visible (see README "Subagents").
   */
  function handleDoctorCommand(ctx: ExtensionContext): void {
    const records = log.readAll();
    const orphans = orphanSubagents(records);
    const uncertain = uncertainRecords(records);
    const ancestorDetectionAvailable = deps.ancestorDetectionAvailable ? deps.ancestorDetectionAvailable() : process.platform !== "win32";

    const lines = [
      `ancestor-chain detection: ${ancestorDetectionAvailable ? "available" : "unavailable"}`,
      `orphan subagent record(s): ${orphans.length}` +
        (orphans.length > 0 ? " — recognised as someone's child (an env marker matched), but no orchestrator could be matched" : ""),
      `uncertain record(s): ${uncertain.length}` +
        (uncertain.length > 0
          ? " — no recognised child-env-marker, but a live tracked ancestor process was found; not counted as a new task, not synced"
          : ""),
    ];

    if (!ancestorDetectionAvailable) {
      lines.push(
        "on this platform/environment, ancestor-chain detection could not run (Windows, or a failed/unavailable ps/proc read): " +
          "an unmarked subagent system may be counted twice (a genuine child with no recognised marker looks like a fresh top-level " +
          "session). Mark it explicitly with KANKAKU_ROLE=subagent in the child's environment (or KANKAKU_ROLE=orchestrator to force " +
          "the other way).",
      );
    }

    if (deps.roleOverride) {
      if (deps.childMarkerPresent) {
        // R1: both signals present — the confirmed child marker always
        // wins (config.ts#detectRole), so the override did not decide
        // anything, whatever it said.
        lines.push(
          `role override: KANKAKU_ROLE=${deps.roleOverride} was present, but the confirmed child marker (GENTLE_PI_AGENTS_CHILD=1) takes precedence — resolved role: subagent`,
        );
      } else if (deps.overrideIgnoredInteractive) {
        lines.push(
          "role override: KANKAKU_ROLE=subagent was ignored for this interactive session (likely a leaked shell export) — resolved role: orchestrator",
        );
      } else {
        lines.push(`role override: KANKAKU_ROLE=${deps.roleOverride} (deciding signal for this process's role)`);
      }
    }

    // C2 item 2/3: a configured child-env marker matched but was ignored
    // for this process's role because it looked interactive — a
    // configured marker, unlike a built-in one, never demotes an
    // interactive session. Escalated when this process also has no
    // tracked ancestor at all (C2 item 3's self-check: the strongest
    // signal the marker is genuinely ambient, not a real subagent
    // mechanism).
    if (deps.configuredMarkerIgnoredInteractive) {
      lines.push(
        deps.hasTrackedAncestor
          ? "configured marker: a KANKAKU_SUBAGENT_CHILD_ENV marker was present but ignored for this interactive session — resolved role: orchestrator"
          : "configured marker: a KANKAKU_SUBAGENT_CHILD_ENV marker was present on this interactive, TOP-LEVEL session (no tracked ancestor) — the marker is likely ambient (set on every process of its kind, not just a subagent's child), not a real subagent mechanism; resolved role: orchestrator",
      );
    }

    // C2 item 1: markers rejected at config load time as looking
    // pi/shell/OS/npm-owned rather than genuinely child-only.
    if (deps.rejectedSubagentChildEnvMarkers && deps.rejectedSubagentChildEnvMarkers.length > 0) {
      for (const rejected of deps.rejectedSubagentChildEnvMarkers) {
        lines.push(`rejected KANKAKU_SUBAGENT_CHILD_ENV marker "${rejected.name}": ${rejected.reason}`);
      }
    }

    // SUBAGENT-REQ-001/002/003/005/017 (6b): active profiles, any configured
    // tool names/markers, which profile matched each subagent record, and
    // any tool-name ambiguity among the active set. Omitted entirely when
    // deps.subagentProfiles was not wired (back-compat).
    if (deps.subagentProfiles) {
      const profiles = deps.subagentProfiles;
      lines.push(`subagent profiles active: ${profiles.map((p) => p.id).join(", ")}`);

      const configured = profiles.find((p) => p.id === "configured");
      if (configured) {
        if (configured.toolNames.length > 0) lines.push(`configured subagent tools: ${configured.toolNames.join(", ")}`);
        if (configured.childEnvMarkers.length > 0) {
          lines.push(`configured child-env markers: ${configured.childEnvMarkers.map((m) => (m.value !== undefined ? `${m.name}=${m.value}` : m.name)).join(", ")}`);
        }
      }

      const subagentRecords = records.filter((record) => record.role === "subagent");
      if (subagentRecords.length > 0) {
        const counts = new Map<string, number>();
        let unmatched = 0;
        for (const record of subagentRecords) {
          if (record.profile) {
            counts.set(record.profile, (counts.get(record.profile) ?? 0) + 1);
          } else {
            unmatched++;
          }
        }
        const parts = profiles.filter((p) => counts.has(p.id)).map((p) => `${p.id}: ${counts.get(p.id)}`);
        if (unmatched > 0) parts.push(`unmatched: ${unmatched}`);
        lines.push(`profile matches: ${parts.join(", ")}`);
      }

      for (const { toolName, profileIds } of findAmbiguousToolNames(profiles)) {
        lines.push(`ambiguous tool name "${toolName}": registered by ${profileIds.join(", ")} — never guessed, resolved by child-env marker or left uncertain`);
      }
    }

    // SUBAGENT-REQ-015 (6c): same-pid overlapping orchestrator records —
    // never observed from any real subagent mechanism today, but flagged
    // here (informational only, never changing buildTasks' own numbers) as
    // the observable signature an in-process nested session would leave.
    for (const overlap of detectSameProcessOverlaps(records)) {
      lines.push(
        `likely in-process nesting: pid ${overlap.pid} has ${overlap.recordIds.length} overlapping orchestrator records (${overlap.recordIds.join(", ")}) — union of their wall time is ${overlap.unionedWallMs}ms`,
      );
    }

    if (deps.workLogRouting?.usedFallback) {
      lines.push(
        `kankaku: this subagent could not write to its orchestrator's directory (${deps.workLogRouting.parentDir}); ` +
          "fell back to its own local worklog — this record may show as an orphan until reunited manually",
      );
    }

    if (deps.registryHealth) {
      const { keep, discard } = deps.registryHealth();
      const counts = new Map<string, number>();
      for (const { reason } of discard) counts.set(reason, (counts.get(reason) ?? 0) + 1);
      const byReason = Array.from(counts.entries())
        .map(([reason, count]) => `${reason}: ${count}`)
        .join(", ");
      lines.push(`registry (~/.kankaku/run): ${keep.length} entrie(s) trusted${discard.length > 0 ? `, ${discard.length} discarded (${byReason})` : ""}`);
    }

    const sessionDir = readNonDefaultSessionDir(ctx.sessionManager);
    if (sessionDir !== undefined) {
      lines.push(`session dir (non-default): ${sessionDir}`);
    }

    showReport(ctx, { title: "doctor", lines });
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
      "'doctor' to report orphan/uncertain subagent counts and ancestor-detection availability (no network). " +
      "When a hub (PocketBase) is configured: 'target' to show the effective client/project and its source, " +
      "'target pick' to run the picker again, 'target clear' to clear the session target, " +
      "'task' (or 'task pick') to link this session to an open/doing hub task of the effective project, " +
      "'task clear' to drop the link, " +
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
      const taskMatch = /^task\s+(\S*)$/.exec(argumentPrefix);
      if (taskMatch) {
        const prefix = taskMatch[1] ?? "";
        return TASK_TOKENS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
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

        if (tokens[0] === "task") {
          await handleTaskCommand(tokens.slice(1), ctx);
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

        if (tokens[0] === "doctor") {
          handleDoctorCommand(ctx);
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
        const lines = formatReport(summary).split(" | ");
        const uncertainCount = countUncertain(records, { all });
        if (uncertainCount > 0) {
          lines.push(`kankaku: ${uncertainCount} uncertain record(s) excluded from tasks — run /kankaku doctor`);
        }
        showReport(ctx, {
          title: all ? "summary (all days)" : "summary (today)",
          lines,
        });
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  return { invalidateClientNames };
}
