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
   * registry. See `domain/task-view.ts`'s `roleConfidence` handling.
   */
  roleConfidence?: "uncertain";
}

/**
 * Classify this process's role. `GENTLE_PI_AGENTS_CHILD=1` stays the only
 * confirmed-subagent signal (unchanged from before this ADR). Otherwise,
 * `hasTrackedAncestor` — whether this process's own OS ancestor chain
 * contains a live entry in the machine-wide process registry (computed by
 * the caller, e.g. `extension.ts`, via `adapters/ancestry.ts` +
 * `domain/ancestry-match.ts`; see `ports/process-registry.ts`) — decides
 * whether an otherwise-unmarked process is a *confirmed* orchestrator (no
 * tracked ancestor at all — today's exact behaviour, unchanged) or merely
 * `uncertain` (ADR 0022's safe default, inverted): a process that cannot be
 * shown to be top-level must never again default to `"orchestrator"`
 * outright.
 */
export function detectRole(env: NodeJS.ProcessEnv = process.env, hasTrackedAncestor = false): RoleDetection {
  if (env["GENTLE_PI_AGENTS_CHILD"] === "1") return { role: "subagent" };
  if (hasTrackedAncestor) return { role: "orchestrator", roleConfidence: "uncertain" };
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
