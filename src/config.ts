import type { SegmentRule } from "./domain/segment-rule.ts";
import type { PromptPrivacyMode } from "./domain/hub-entry.ts";
import { BUILTIN_SUBAGENT_PROFILES, buildConfiguredProfile, matchesAnyMarker } from "./domain/subagent-profile.ts";
import type { ChildEnvMarker, SubagentProfile } from "./domain/subagent-profile.ts";

export interface KankakuConfig {
  /** Directory for the work log, relative to the project cwd unless absolute. */
  dir: string;
  /** Tool names whose execution span counts as waiting time. */
  interactiveTools: string[];
  /**
   * Every active {@link SubagentProfile} (ADR 0020): the built-ins
   * (gentle-pi, pi's bundled reference example, pi-subagents) plus, when
   * `KANKAKU_SUBAGENT_TOOLS`/`KANKAKU_SUBAGENT_CHILD_ENV` are set, one
   * additional `"configured"` profile — always additive, never replacing
   * gentle-pi's own recognition. `SUBAGENT_TOOL` is no longer a hardcoded
   * constant; `domain/work-tracker.ts` matches subagent tool calls against
   * the union of every profile's `toolNames`.
   */
  subagentProfiles: SubagentProfile[];
  /** Rules that tag a tool execution's span under a named segment (e.g. `review`). */
  segmentRules: SegmentRule[];
  /** Default billing client for this project, from `KANKAKU_CLIENT`. See `domain/client-label.ts`. */
  client?: string;
  /**
   * C2 (CRITICAL fix): every `KANKAKU_SUBAGENT_CHILD_ENV` entry rejected by
   * {@link validateSubagentChildEnvMarkers} — a marker name that looks like
   * an ambient pi/shell/OS/npm environment variable, not a genuine
   * child-only marker. Always present (empty when nothing was configured,
   * or everything configured was accepted), so a caller never has to guard
   * against it being `undefined`. `/kankaku doctor` and a one-time
   * `ctx.ui.notify` are expected to surface this (see `adapters/pi-tracker.ts`).
   */
  rejectedSubagentChildEnvMarkers: RejectedChildEnvMarker[];
}

/** One `KANKAKU_SUBAGENT_CHILD_ENV` marker {@link validateSubagentChildEnvMarkers} rejected, with why. */
export interface RejectedChildEnvMarker {
  name: string;
  reason: string;
}

const DEFAULT_DIR = ".kankaku";
const DEFAULT_INTERACTIVE_TOOLS = ["ask_user_question", "ask_user_choice"];

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

/**
 * SUBAGENT-REQ-002: `KANKAKU_SUBAGENT_TOOLS`, a comma-separated list of
 * additional tool names treated as subagent-launching spans, parsed with
 * the exact same tolerant trim-and-filter-empty convention as
 * `KANKAKU_INTERACTIVE_TOOLS` above.
 */
function parseSubagentTools(raw: string): string[] {
  return raw
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
}

/**
 * SUBAGENT-REQ-003: `KANKAKU_SUBAGENT_CHILD_ENV`, a `;`-separated list of
 * `NAME=VALUE` or bare `NAME` child-process env markers — mirrors
 * `KANKAKU_SEGMENTS`'s tolerant `;`-separated convention. A bare `NAME`
 * marks presence-only (any non-empty value matches, e.g. pi-subagents'
 * depth counter); `NAME=VALUE` requires an exact match. An entry with no
 * name, or a trailing `=` with nothing after it, is malformed and skipped
 * rather than failing the whole variable.
 */
function parseSubagentChildEnv(raw: string): ChildEnvMarker[] {
  const markers: ChildEnvMarker[] = [];

  for (const entry of raw.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      const name = trimmed;
      if (name) markers.push({ name });
      continue;
    }

    const name = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!name || !value) continue;
    markers.push({ name, value });
  }

  return markers;
}

/**
 * C2 (CRITICAL fix, item 1): exact marker names pi sets on EVERY process it
 * runs (verified: `dist/cli/setup.js:5` sets `PI_CODING_AGENT=true`,
 * `dist/rpc-entry.js:6` sets `AI_AGENT=pi` — both unconditionally, not just
 * for a subagent's child) or that are otherwise ordinary, ambient
 * shell/OS/npm-lifecycle environment, never something a real child-only
 * marker would legitimately reuse.
 */
const DENIED_MARKER_NAMES = new Set(["PI_CODING_AGENT", "AI_AGENT", "PATH", "HOME", "USER", "SHELL", "PWD", "CI", "LANG", "TMUX"]);

/** C2 item 1: namespace prefixes an ambient variable is overwhelmingly likely to fall under — a genuine child-only marker should never need one of these either. */
const DENIED_MARKER_PREFIXES = ["PI_", "TERM", "LC_", "NODE_", "NPM_", "KANKAKU_"];

/** What an environment variable name may look like; anything else is a typo, never a marker. */
const VALID_MARKER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `undefined` when `name` is an acceptable marker name; otherwise a human-readable reason it was rejected. Matching is case-insensitive — an env var name's case carries no meaning here. */
function deniedMarkerReason(name: string): string | undefined {
  // A name that is not a valid environment variable name can never match a
  // real variable: accepting it would silently disable the user's
  // configuration AND hide any ambient name inside it from the denylist
  // below. The usual cause is typing commas, as `KANKAKU_SUBAGENT_TOOLS`
  // takes, where this list is `;`-separated.
  if (!VALID_MARKER_NAME.test(name)) {
    return `"${name}" is not a valid environment variable name — separate several markers with ";" (not ","), each as NAME or NAME=VALUE`;
  }
  const upper = name.toUpperCase();
  if (DENIED_MARKER_NAMES.has(upper)) {
    return `${name} is an ambient variable pi or the shell sets on EVERY process, not a marker exclusive to a subagent's child`;
  }
  for (const prefix of DENIED_MARKER_PREFIXES) {
    if (upper.startsWith(prefix)) {
      return `${name} looks like a pi/npm/shell-namespaced environment variable (prefix "${prefix}"), not a marker a third-party subagent tool would set`;
    }
  }
  return undefined;
}

/**
 * C2 (CRITICAL fix, item 1): validate every `KANKAKU_SUBAGENT_CHILD_ENV`
 * marker against the denylist above, config-time. A rejected marker is
 * never added to the `"configured"` profile — so it can never demote a
 * user's own top-level session to `role: "subagent"` in the first place
 * (layered with C2 items 2/3's runtime interactive guard in
 * `config.ts#detectRole`, which still protects a marker this denylist does
 * not happen to catch). `loadConfig` surfaces `rejected` via
 * `KankakuConfig.rejectedSubagentChildEnvMarkers` for `/kankaku doctor` and
 * a one-time `ctx.ui.notify`.
 */
export function validateSubagentChildEnvMarkers(markers: readonly ChildEnvMarker[]): {
  accepted: ChildEnvMarker[];
  rejected: RejectedChildEnvMarker[];
} {
  const accepted: ChildEnvMarker[] = [];
  const rejected: RejectedChildEnvMarker[] = [];
  for (const marker of markers) {
    const reason = deniedMarkerReason(marker.name);
    if (reason) {
      rejected.push({ name: marker.name, reason });
    } else {
      accepted.push(marker);
    }
  }
  return { accepted, rejected };
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

  const subagentToolsRaw = env["KANKAKU_SUBAGENT_TOOLS"]?.trim();
  const configuredTools = subagentToolsRaw ? parseSubagentTools(subagentToolsRaw) : [];
  const subagentChildEnvRaw = env["KANKAKU_SUBAGENT_CHILD_ENV"]?.trim();
  const parsedMarkers = subagentChildEnvRaw ? parseSubagentChildEnv(subagentChildEnvRaw) : [];
  // C2 (CRITICAL fix, item 1): a denylisted marker name is never handed to
  // buildConfiguredProfile at all — it can never demote a session's role,
  // and is instead surfaced via rejectedSubagentChildEnvMarkers below.
  const { accepted: configuredMarkers, rejected: rejectedSubagentChildEnvMarkers } = validateSubagentChildEnvMarkers(parsedMarkers);
  const configuredProfile = buildConfiguredProfile(configuredTools, configuredMarkers);
  const subagentProfiles: SubagentProfile[] = [...BUILTIN_SUBAGENT_PROFILES, ...(configuredProfile ? [configuredProfile] : [])];

  return {
    dir,
    interactiveTools,
    subagentProfiles,
    segmentRules,
    rejectedSubagentChildEnvMarkers,
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
  /**
   * C2 item 2/3: set when a USER-CONFIGURED child-env marker
   * (`KANKAKU_SUBAGENT_CHILD_ENV`, the `configuredMarkers` 5th param below)
   * matched, but was ignored for this process's `role` because it looked
   * interactive — a configured marker, unlike a BUILT-IN one, never demotes
   * an interactive session (see this function's precedence doc). The
   * caller is expected to surface this once (mirroring
   * `overrideIgnoredInteractive`) via `ctx.ui.notify` and `/kankaku
   * doctor`, and to escalate the wording when this process also has no
   * tracked ancestor at all — the strongest signal the marker is genuinely
   * ambient (C2 item 3's self-check), not a real subagent mechanism.
   */
  configuredMarkerIgnoredInteractive?: true;
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
 *
 * C2 (CRITICAL fix): `childMarkers` (built-in tier, step 1 above) and
 * `configuredMarkers` (the 5th param) are now two DIFFERENT tiers, not one
 * merged list. A BUILT-IN marker (`GENTLE_PI_AGENTS_CHILD`,
 * `PI_SUBAGENT_DEPTH`) is set only by a real subagent runner and always
 * wins outright, exactly as step 1 describes — verified that no built-in
 * mechanism kankaku recognises ever launches its child interactively (see
 * `domain/subagent-profile.ts#PI_SUBAGENTS_PROFILE`'s doc comment), so this
 * tier never actually needs the interactive exception in practice, and
 * keeping it unconditional avoids a behaviour change for it. A
 * USER-CONFIGURED marker (`KANKAKU_SUBAGENT_CHILD_ENV`), by contrast, names
 * an arbitrary environment variable kankaku cannot verify is child-only —
 * pi itself sets `PI_CODING_AGENT`/`AI_AGENT` on EVERY process, and a naive
 * choice like that (or `CI`, `TMUX`, an exported shell var) would make the
 * user's own top-level interactive session `role: "subagent"` with no
 * parent, never anchoring a task and unrecoverable once written (the log
 * is append-only). So a configured marker gets EXACTLY the same
 * interactive exception `KANKAKU_ROLE=subagent` already has (step 2): it
 * never demotes an interactive session — `configuredMarkerIgnoredInteractive`
 * is set instead, so the caller can self-check and surface the
 * contradiction (C2 item 3) rather than silently trusting an ambient
 * marker. See `config.ts#loadConfig`'s denylist for the config-time half of
 * this fix (rejecting an obviously-ambient marker name outright).
 */
/** `detectRole`'s default `childMarkers` when a caller does not pass its own active profile set — identical to the single marker this function hardcoded before SUBAGENT-REQ-001/002/003, so every pre-existing 3-arg call site keeps behaving exactly as before. */
const DEFAULT_CHILD_MARKERS: ChildEnvMarker[] = [{ name: "GENTLE_PI_AGENTS_CHILD", value: "1" }];

export function detectRole(
  env: NodeJS.ProcessEnv = process.env,
  hasTrackedAncestor = false,
  isInteractive = true,
  /** SUBAGENT-REQ-002/003: built-in profiles' own child-env markers ONLY (never the user-configured one — see `configuredMarkers` below) — generalises the single hardcoded `GENTLE_PI_AGENTS_CHILD` check without changing precedence. See `domain/subagent-profile.ts#builtinChildMarkers`. */
  childMarkers: readonly ChildEnvMarker[] = DEFAULT_CHILD_MARKERS,
  /** C2: the user-configured profile's child-env marker(s) only (`KANKAKU_SUBAGENT_CHILD_ENV`, already denylist-filtered by `loadConfig`) — a SEPARATE, weaker tier: it can confirm a subagent, but unlike `childMarkers` above, never demotes an interactive session. See `domain/subagent-profile.ts#configuredChildMarkers`. */
  configuredMarkers: readonly ChildEnvMarker[] = [],
): RoleDetection {
  if (matchesAnyMarker(env, childMarkers)) return { role: "subagent" };

  const configuredMatch = matchesAnyMarker(env, configuredMarkers);
  if (configuredMatch && !isInteractive) return { role: "subagent" };

  let result: RoleDetection;
  const override = readRoleOverride(env);

  if (override === "orchestrator") {
    result = { role: "orchestrator" };
  } else if (override === "subagent") {
    result = isInteractive ? { role: "orchestrator", overrideIgnoredInteractive: true } : { role: "subagent" };
  } else if (hasTrackedAncestor && !isInteractive) {
    result = { role: "orchestrator", roleConfidence: "uncertain" };
  } else {
    result = { role: "orchestrator" };
  }

  // The configured marker matched but was ignored (this process is
  // interactive) — flagged regardless of what else decided `result`, so the
  // caller always learns a configured marker is present-but-ambient here.
  return configuredMatch && isInteractive ? { ...result, configuredMarkerIgnoredInteractive: true } : result;
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
