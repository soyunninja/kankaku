import type { SegmentRule } from "./domain/segment-rule.ts";
import type { PromptPrivacyMode } from "./domain/hub-entry.ts";

export interface KankakuConfig {
  /** Directory for the work log, relative to the project cwd unless absolute. */
  dir: string;
  /** Tool names whose execution span counts as waiting time. */
  interactiveTools: string[];
  /** Tool name used to run subagents. */
  subagentTool: string;
  /** Rules that tag a tool execution's span under a named segment (e.g. `review`). */
  segmentRules: SegmentRule[];
  /** Default billing client for this project, from `KANKAKU_CLIENT`. See `domain/client-label.ts`. */
  client?: string;
}

const DEFAULT_DIR = ".kankaku";
const DEFAULT_INTERACTIVE_TOOLS = ["ask_user_question", "ask_user_choice"];
const SUBAGENT_TOOL = "subagent_run";

/**
 * Default segment rule: with gentle-ai, the review-with-receipts step runs
 * as `gentle-ai review ...` commands through the `bash` tool, so tag that
 * span `review`.
 */
const DEFAULT_SEGMENT_RULES: SegmentRule[] = [{ tag: "review", tool: "bash", pattern: /\bgentle-ai review\b/ }];

/** Tags allowed for a segment rule: letters, digits, `_` and `-`, 1-32 chars. */
const SAFE_TAG = /^[A-Za-z0-9_-]{1,32}$/;
/** Property names that behave specially on a plain object; never usable as a tag. */
const RESERVED_TAGS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeTag(tag: string): boolean {
  return SAFE_TAG.test(tag) && !RESERVED_TAGS.has(tag);
}

/**
 * Parse `KANKAKU_SEGMENTS`, a `;`-separated list of `tag=tool:regex`
 * entries (example: `review=bash:gentle-ai review;commit=bash:git commit`).
 * Malformed entries (missing tag, tool or regex, an invalid regex source,
 * or a tag that is not a safe identifier such as `__proto__`) are skipped
 * rather than failing the whole variable.
 */
function parseSegmentRules(raw: string): SegmentRule[] {
  const rules: SegmentRule[] = [];

  for (const entry of raw.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;

    const tag = trimmed.slice(0, eqIndex).trim();
    const rest = trimmed.slice(eqIndex + 1);
    const colonIndex = rest.indexOf(":");
    if (colonIndex <= 0) continue;

    const tool = rest.slice(0, colonIndex).trim();
    const regexSource = rest.slice(colonIndex + 1).trim();
    if (!tag || !tool || !regexSource || !isSafeTag(tag)) continue;

    try {
      rules.push({ tag, tool, pattern: new RegExp(regexSource) });
    } catch {
      continue;
    }
  }

  return rules;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KankakuConfig {
  const dir = env["KANKAKU_DIR"]?.trim() || DEFAULT_DIR;
  const interactiveToolsRaw = env["KANKAKU_INTERACTIVE_TOOLS"]?.trim();
  const interactiveTools = interactiveToolsRaw
    ? interactiveToolsRaw
        .split(",")
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0)
    : DEFAULT_INTERACTIVE_TOOLS;

  const segmentsRaw = env["KANKAKU_SEGMENTS"]?.trim();
  const segmentRules = segmentsRaw ? parseSegmentRules(segmentsRaw) : DEFAULT_SEGMENT_RULES;

  const client = env["KANKAKU_CLIENT"]?.trim() || undefined;

  return {
    dir,
    interactiveTools,
    subagentTool: SUBAGENT_TOOL,
    segmentRules,
    ...(client !== undefined ? { client } : {}),
  };
}

export interface RoleDetection {
  role: "orchestrator" | "subagent";
  /**
   * Set only when this process could not be positively proven top-level
   * (ADR 0022's four-state classification, applied on top of the still-
   * binary `role`): no recognised child-env-marker matched, but a live
   * tracked ancestor process was found via the machine-wide process
   * registry, AND this process is not itself an interactive session (see
   * `isInteractive` below — F3). See `domain/task-view.ts`'s
   * `roleConfidence` handling.
   */
  roleConfidence?: "uncertain";
  /**
   * Set when `KANKAKU_ROLE=subagent` was present, with no confirmed child
   * marker, but was ignored because this process looked interactive (see
   * this function's precedence doc — R1). The caller (`extension.ts`) is
   * expected to surface this once via `ctx.ui.notify` at `session_start`
   * and report it in `/kankaku doctor`, so the contradiction is never
   * silent.
   */
  overrideIgnoredInteractive?: true;
}

export type RoleOverride = "orchestrator" | "subagent";

/**
 * `KANKAKU_ROLE`: an explicit escape hatch for a genuine session
 * `detectRole` gets wrong (no reliable automatic signal exists for it),
 * and for a legacy/JSONL record already written `uncertain`, which can
 * never be rewritten after the fact (the log is append-only) but whose
 * *next* run can be told the truth directly. It does **not** override
 * every other signal unconditionally any more — see `detectRole`'s
 * precedence doc (R1) for the confirmed-child-marker and interactive-
 * session exceptions this now has. An unrecognised value (anything other
 * than exactly `"orchestrator"` or `"subagent"`) is ignored, falling back
 * to normal detection, rather than failing the process or guessing.
 */
export function readRoleOverride(env: NodeJS.ProcessEnv = process.env): RoleOverride | undefined {
  const raw = env["KANKAKU_ROLE"]?.trim();
  return raw === "orchestrator" || raw === "subagent" ? raw : undefined;
}

/**
 * Remove `KANKAKU_ROLE` from `env` in place (R1, layer 2 — non-
 * propagation). `KANKAKU_ROLE` decides only THIS process's role; a child
 * this process spawns (a subagent runner, a tool shell) must never inherit
 * it, since `process.env` is inherited by every OS child by default. Left
 * unstripped, a user who once hit a false `uncertain` and exported
 * `KANKAKU_ROLE=orchestrator` in a shell rc/tmux/CI environment would have
 * every subsequent subagent see it too — layer 1's precedence fix
 * (a confirmed child marker always wins) already neutralises that specific
 * leak for a *recognised* subagent mechanism, but this strips it outright
 * so it can never reach an unrecognised one, or reach an unrelated child
 * process this one spawns for some other reason. Takes the env object as
 * a parameter, rather than reaching for `process.env` itself, so this
 * stays a pure function tests can exercise against a plain object without
 * ever mutating the real environment — `extension.ts` is the one caller
 * that passes the real `process.env`, right after reading the override.
 */
export function stripRoleOverride(env: NodeJS.ProcessEnv): void {
  delete env["KANKAKU_ROLE"];
}

/**
 * Classify this process's role, strictly in this order (R1 rewrote this
 * precedence — a leaked `KANKAKU_ROLE` must never out-rank a *confirmed*
 * signal, and must never silently drop a genuine interactive session):
 *
 * 1. `GENTLE_PI_AGENTS_CHILD=1` — the automatic confirmed-subagent marker,
 *    set only by the subagent runner itself, never something a shell
 *    rc/tmux/CI environment would export. **Always wins**, even over an
 *    explicit `KANKAKU_ROLE=orchestrator` — without this, a leaked
 *    `KANKAKU_ROLE=orchestrator` export would turn every one of this
 *    process's genuine subagent invocations into a confirmed,
 *    independently-billed orchestrator too (the bug this fixes).
 * 2. `KANKAKU_ROLE` (F3's explicit escape hatch), when set to a recognised
 *    value and no confirmed marker matched above — with one exception:
 *    `KANKAKU_ROLE=subagent` in an **interactive** session (`isInteractive`
 *    — see below) is ignored. No subagent mechanism kankaku recognises
 *    ever launches its child interactively; an interactive session with
 *    this override set and no marker to back it up is therefore almost
 *    certainly a leaked shell export, not a real subagent. Honouring it
 *    would silently drop this session's own work from every report and
 *    the hub (an orphaned subagent record that never anchors a task) with
 *    no way to recover it later, since `worklog.jsonl` is append-only.
 *    Between the package's two guiding rules — "undercount is recoverable,
 *    overcount is not" (which governs the *opposite* risk, inventing extra
 *    billing, and does not apply here) and "never silently drop genuine
 *    work" — this is governed by the second: the override is ignored, this
 *    process is classified `orchestrator` (what it structurally must be),
 *    and `overrideIgnoredInteractive` is set so the caller can surface the
 *    contradiction instead of resolving it silently. A non-interactive
 *    process gets exactly what it asked for. `KANKAKU_ROLE=orchestrator`
 *    has no such exception — forcing a session `orchestrator` can never
 *    drop work, only (rarely) invent a task that should not exist, a risk
 *    the user accepted by setting it explicitly.
 * 3. `hasTrackedAncestor` — whether this process's own OS ancestor chain
 *    contains a live, identity-verified entry in the machine-wide process
 *    registry (computed by the caller, e.g. `adapters/subagent-startup.ts`,
 *    via `adapters/ancestry.ts` + `domain/ancestry-match.ts`; see
 *    `ports/process-registry.ts`) — combined with `isInteractive`: only a
 *    *non-interactive* process with a tracked ancestor is demoted to
 *    `uncertain` (ADR 0022's safe default, inverted). An interactive TUI
 *    session on a real terminal is a human's own session even when some
 *    ancestor happens to be a tracked pi process (e.g. pi launched from
 *    inside another pi's shell tool) — every subagent mechanism kankaku
 *    recognises launches its child non-interactively over pipes, so
 *    `isInteractive` alone already tells a genuine top-level session apart
 *    from one that could plausibly be someone's silent child.
 *
 * `isInteractive` defaults to `true` — the same conservative default used
 * for both the interactive-override exception above and the `uncertain`
 * fallback below, since a caller that does not yet know it (see
 * `extension.ts`'s factory-time synchronous TTY proxy, and F3's later,
 * authoritative `ctx.mode === "tui"` refinement of `roleConfidence` only —
 * never of `role` itself) should never wrongly honour a `subagent` override
 * or demote a session to `uncertain` before it can find out.
 *
 * A process that cannot be shown to be top-level by any of the above must
 * never default to `"orchestrator"` outright — but see F2: when ancestor
 * detection itself is unavailable (platform, or a failed/timed-out probe),
 * `hasTrackedAncestor` is simply `false` (nothing was found), which already
 * falls through to a confirmed orchestrator here — the *old*, pre-ADR-0022
 * behaviour on such a platform, deliberately: marking every unprovable
 * process `uncertain` there would drop all of a Windows user's genuine
 * work, a far worse failure than the narrow overcount this guards against
 * elsewhere. `/kankaku doctor` is responsible for making that unavailable-
 * detection limitation visible; it is never encoded in `roleConfidence`.
 */
export function detectRole(env: NodeJS.ProcessEnv = process.env, hasTrackedAncestor = false, isInteractive = true): RoleDetection {
  if (env["GENTLE_PI_AGENTS_CHILD"] === "1") return { role: "subagent" };

  const override = readRoleOverride(env);

  if (override === "orchestrator") return { role: "orchestrator" };

  if (override === "subagent") {
    return isInteractive ? { role: "orchestrator", overrideIgnoredInteractive: true } : { role: "subagent" };
  }

  if (hasTrackedAncestor && !isInteractive) return { role: "orchestrator", roleConfidence: "uncertain" };
  return { role: "orchestrator" };
}

/** Hub (PocketBase) credentials read from the environment; any field can be absent. */
export interface HubEnvCredentials {
  url?: string;
  email?: string;
  password?: string;
}

/** Read `KANKAKU_PB_URL`/`KANKAKU_PB_EMAIL`/`KANKAKU_PB_PASSWORD`. Empty/whitespace-only values are treated as absent. */
export function loadHubEnvCredentials(env: NodeJS.ProcessEnv = process.env): HubEnvCredentials {
  return {
    url: env["KANKAKU_PB_URL"]?.trim() || undefined,
    email: env["KANKAKU_PB_EMAIL"]?.trim() || undefined,
    password: env["KANKAKU_PB_PASSWORD"]?.trim() || undefined,
  };
}

/** `KANKAKU_MACHINE`, or `hostname()` when unset/blank. Injected so this stays testable without touching `os.hostname`. */
export function loadMachine(env: NodeJS.ProcessEnv, hostname: () => string): string {
  return env["KANKAKU_MACHINE"]?.trim() || hostname();
}

/** Hosts allowed to use a plain-HTTP hub URL. */
function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/** Hub sync (Phase 2) configuration, read from the environment. See README "Hub (PocketBase)" sync section. */
export interface SyncConfig {
  /** `KANKAKU_SYNC_PROMPT`. Defaults to `"none"` — the conservative default (proposal §8). */
  promptMode: PromptPrivacyMode;
  /** `KANKAKU_SYNC_WINDOW_HOURS`. Defaults to 24; falls back to the default for a non-positive or non-numeric value. */
  windowHours: number;
  /** `KANKAKU_SYNC_RECORDS`. Defaults to enabled; `"0"` disables uploading `work_records` children. */
  syncRecords: boolean;
  /** `KANKAKU_SYNC_AUTO`. Defaults to enabled; `"0"` disables the fire-and-forget session_start/agent_settled sync. */
  auto: boolean;
  /**
   * `KANKAKU_SYNC_MIN_INTERVAL_MINUTES`. How often the *automatic*
   * (`session_start`/`agent_settled`) sync path is allowed to actually run
   * a sync, at most. Defaults to 5; `0` disables throttling entirely. Never
   * applies to a manual `/kankaku sync`, `sync all`, or `backfill`. See
   * `adapters/sync-runner.ts#runSync`.
   */
  minIntervalMinutes: number;
}

const VALID_PROMPT_MODES = new Set<PromptPrivacyMode>(["none", "truncated", "full"]);
const DEFAULT_SYNC_WINDOW_HOURS = 24;
const DEFAULT_SYNC_MIN_INTERVAL_MINUTES = 5;

export function loadSyncConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const promptRaw = env["KANKAKU_SYNC_PROMPT"]?.trim();
  const promptMode: PromptPrivacyMode = promptRaw && VALID_PROMPT_MODES.has(promptRaw as PromptPrivacyMode) ? (promptRaw as PromptPrivacyMode) : "none";

  const windowRaw = env["KANKAKU_SYNC_WINDOW_HOURS"]?.trim();
  const parsedWindow = windowRaw ? Number(windowRaw) : NaN;
  const windowHours = Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : DEFAULT_SYNC_WINDOW_HOURS;

  const syncRecords = env["KANKAKU_SYNC_RECORDS"]?.trim() !== "0";
  const auto = env["KANKAKU_SYNC_AUTO"]?.trim() !== "0";

  // 0 is a valid, explicit "disable throttling" value, distinct from an
  // unset or garbage one (which falls back to the default) — unlike
  // windowHours above, which treats 0 as invalid.
  const minIntervalRaw = env["KANKAKU_SYNC_MIN_INTERVAL_MINUTES"]?.trim();
  const parsedMinInterval = minIntervalRaw ? Number(minIntervalRaw) : NaN;
  const minIntervalMinutes = Number.isFinite(parsedMinInterval) && parsedMinInterval >= 0 ? parsedMinInterval : DEFAULT_SYNC_MIN_INTERVAL_MINUTES;

  return { promptMode, windowHours, syncRecords, auto, minIntervalMinutes };
}

export type HubUrlValidation = { ok: true } | { ok: false; reason: string };

/**
 * A hub URL must be HTTPS, unless it points at localhost/127.0.0.1/::1 (a
 * local PocketBase instance for development). Also rejects a URL that does
 * not parse at all.
 */
export function validateHubUrl(url: string): HubUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `kankaku: invalid hub URL: ${url}` };
  }

  if (parsed.protocol === "https:") return { ok: true };
  if (parsed.protocol === "http:" && isLocalHost(parsed.hostname)) return { ok: true };

  return { ok: false, reason: `kankaku: refusing non-HTTPS hub URL (only localhost is allowed over plain HTTP): ${url}` };
}
