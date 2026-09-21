import type { UsageTotals } from "./work-record.ts";

/**
 * A child-process env marker a {@link SubagentProfile} recognises as
 * confirmation that THIS process is one of its children (never guessed —
 * see `resolveChildProfile`). `value: undefined` means "any non-empty
 * value counts as present" (e.g. pi-subagents' `PI_SUBAGENT_DEPTH`, a
 * recursion-depth counter, not a fixed sentinel); a defined `value`
 * requires an exact match (e.g. gentle-pi's `GENTLE_PI_AGENTS_CHILD=1`).
 */
export interface ChildEnvMarker {
  name: string;
  value?: string;
}

/**
 * How strongly a profile's children can be joined back to their
 * orchestrator (ADR 0021): `"explicit-id"` when the tool result carries a
 * stable id kankaku can use directly (gentle-pi's `taskId` — parent-side
 * only, the child cannot read its own); `"ancestry"` when only the
 * machine-wide process registry/ancestor-chain walk can join it;
 * `"none"` for a profile that offers no join signal at all.
 */
export type JoinKeyConfidence = "explicit-id" | "ancestry" | "none";

export interface SubagentLaunchInfo {
  agent?: string;
  mode?: string;
}

export interface SubagentResultInfo {
  taskId?: string;
  agent?: string;
  status?: string;
  mode?: string;
  cwd?: string;
  /**
   * Nested LLM usage the subagent tool result reports on itself (pi's
   * documented convention: "a tool making nested LLM calls should return
   * their combined Usage as `usage`" — see `docs/extensions.md`). A
   * profile whose children are ALSO separately tracked and joined via a
   * confirmed child-env marker (ancestry-based `joinKeyConfidence`) must
   * never report this — see `PI_SUBAGENTS_PROFILE` for why.
   */
  usage?: Partial<UsageTotals>;
}

/**
 * Declares how kankaku recognises one subagent-launching ecosystem
 * package: which tool call(s) open a subagent span, how to read
 * `agent`/`mode` from the launch args and `taskId`/`status`/`mode`/`cwd`/
 * `usage` from the tool result, which env var(s) confirm a child process of
 * this kind, and how strong a join key it offers. See ADR 0020 and
 * SUBAGENT-REQ-001.
 */
export interface SubagentProfile {
  id: string;
  toolNames: readonly string[];
  childEnvMarkers: readonly ChildEnvMarker[];
  joinKeyConfidence: JoinKeyConfidence;
  readLaunchArgs(args: Record<string, unknown> | undefined): SubagentLaunchInfo;
  readResult(result: unknown): SubagentResultInfo;
}

function readGentleAgents(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const gentleAgents = (details as { gentleAgents?: unknown }).gentleAgents;
  if (!gentleAgents || typeof gentleAgents !== "object") return undefined;
  return gentleAgents as Record<string, unknown>;
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Read pi's generic, profile-agnostic nested-usage convention: the tool
 * RESULT's own top-level `usage` field (never nested under a profile's
 * custom `details`). Tolerant of a missing/malformed field or non-numeric
 * members — returns `undefined` (not an empty object) when nothing usable
 * was found, so "no usage reported" stays distinguishable from "usage
 * reported as all-zero".
 */
function readStandardUsage(result: unknown): Partial<UsageTotals> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const raw = (result as { usage?: unknown }).usage;
  if (!raw || typeof raw !== "object") return undefined;

  const usage: Partial<UsageTotals> = {};
  const fields: Array<keyof UsageTotals> = ["input", "output", "cacheRead", "cacheWrite", "cost"];
  for (const field of fields) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value)) usage[field] = value;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function readAgentModeArgs(args: Record<string, unknown> | undefined): SubagentLaunchInfo {
  const agent = stringField(args, "agent");
  const mode = stringField(args, "mode");
  return { ...(agent !== undefined ? { agent } : {}), ...(mode !== undefined ? { mode } : {}) };
}

/**
 * gentle-pi (first-class, ADR 0020): the richest, most robust profile —
 * explicit `taskId` join, live `status`, `mode` (task/background) and
 * cross-worktree `cwd`, all read from `result.details.gentleAgents`
 * exactly as `work-tracker.ts#extractTaskId` did before this module
 * existed. Verified against gentle-pi 3.3.0 source
 * (`extensions/gentle-agents.ts`, `lib/agents-protocol.ts`,
 * `lib/agents-runner.ts`): its tool result never carries a top-level
 * `usage` field (children are separate OS processes, cost tracked
 * independently through the existing ancestry/registry join) — this
 * profile therefore never reports `usage`, so 6c's forwarding never
 * touches gentle-pi's numbers.
 */
export const GENTLE_PI_PROFILE: SubagentProfile = {
  id: "gentle-pi",
  toolNames: ["subagent_run"],
  childEnvMarkers: [{ name: "GENTLE_PI_AGENTS_CHILD", value: "1" }],
  joinKeyConfidence: "explicit-id",
  readLaunchArgs: readAgentModeArgs,
  readResult(result) {
    const gentleAgents = readGentleAgents(result);
    if (!gentleAgents) return {};
    const taskId = stringField(gentleAgents, "taskId");
    const agent = stringField(gentleAgents, "agent");
    const status = stringField(gentleAgents, "status");
    const mode = stringField(gentleAgents, "mode");
    const cwd = stringField(gentleAgents, "cwd");
    return {
      ...(taskId !== undefined ? { taskId } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
  },
};

/**
 * pi's bundled reference example extension
 * (`examples/extensions/subagent/index.ts`, tool `subagent`). Verified: its
 * `spawn()` call passes no `env` option at all (the child simply inherits
 * the parent's environment unmodified) — so it sets NO child-identifying
 * env marker, and a child of this kind can only ever be recognised through
 * ancestry (ADR 0020: "always starts uncertain"). Because it has no
 * marker, it can never become a *confirmed* `role: "subagent"` record
 * (see `resolveChildProfile`) and therefore can never be double-joined —
 * safe to forward `usage` unconditionally.
 */
export const PI_REFERENCE_PROFILE: SubagentProfile = {
  id: "pi-reference",
  toolNames: ["subagent"],
  childEnvMarkers: [],
  joinKeyConfidence: "ancestry",
  readLaunchArgs: readAgentModeArgs,
  readResult(result) {
    const usage = readStandardUsage(result);
    return { ...(usage !== undefined ? { usage } : {}) };
  },
};

/**
 * pi-subagents (npm package, tool `subagent`, action-based). Verified
 * against the installed 0.28.0 source (`src/shared/types.ts`
 * `getSubagentDepthEnv`): every child it spawns (foreground AND the
 * detached background runner) carries `PI_SUBAGENT_DEPTH` — NOT
 * `PI_SUBAGENT_PARENT_SESSION`, an earlier, unverified assumption this
 * profile deliberately does not use. Because this marker CAN confirm a
 * child as `role: "subagent"` (ancestry-joined, its own usage/cost already
 * counted through that join), this profile's `readResult` deliberately
 * never forwards `usage` even when present — forwarding it here would risk
 * counting the same nested LLM work twice (once via the join, once via the
 * forwarded figure). See `GENTLE_PI_PROFILE`/`PI_REFERENCE_PROFILE` for the
 * two cases where forwarding is safe.
 */
export const PI_SUBAGENTS_PROFILE: SubagentProfile = {
  id: "pi-subagents",
  toolNames: ["subagent"],
  childEnvMarkers: [{ name: "PI_SUBAGENT_DEPTH" }],
  joinKeyConfidence: "ancestry",
  readLaunchArgs(args) {
    const agent = stringField(args, "agent");
    const mode = stringField(args, "action");
    return { ...(agent !== undefined ? { agent } : {}), ...(mode !== undefined ? { mode } : {}) };
  },
  readResult() {
    return {};
  },
};

export const BUILTIN_SUBAGENT_PROFILES: readonly SubagentProfile[] = [GENTLE_PI_PROFILE, PI_REFERENCE_PROFILE, PI_SUBAGENTS_PROFILE];

/**
 * SUBAGENT-REQ-001/002/003: the user-configured profile built from
 * `KANKAKU_SUBAGENT_TOOLS`/`KANKAKU_SUBAGENT_CHILD_ENV` (parsed in
 * `config.ts`, mirroring `KANKAKU_INTERACTIVE_TOOLS`'s tolerant
 * comma-split convention). Always additive to the built-ins, never
 * replacing gentle-pi's own recognition. `undefined` when neither is
 * configured, so `loadConfig` never adds an inert profile. Forwards
 * `result.usage` generically (like `PI_REFERENCE_PROFILE`) — a documented,
 * unavoidable residual risk: kankaku cannot know whether an arbitrary
 * configured child process also runs kankaku itself and would otherwise be
 * ancestry-joined, so a user who configures BOTH a child-env marker AND a
 * tool that forwards `usage` for the same third-party package accepts that
 * narrow double-count risk (see README "Subagents").
 */
export function buildConfiguredProfile(toolNames: readonly string[], childEnvMarkers: readonly ChildEnvMarker[]): SubagentProfile | undefined {
  if (toolNames.length === 0 && childEnvMarkers.length === 0) return undefined;
  return {
    id: "configured",
    toolNames,
    childEnvMarkers,
    joinKeyConfidence: "ancestry",
    readLaunchArgs: readAgentModeArgs,
    readResult(result) {
      const usage = readStandardUsage(result);
      return { ...(usage !== undefined ? { usage } : {}) };
    },
  };
}

/** Every profile whose `toolNames` include `toolName`, in the given order. */
export function matchToolProfiles(profiles: readonly SubagentProfile[], toolName: string): SubagentProfile[] {
  return profiles.filter((profile) => profile.toolNames.includes(toolName));
}

export interface ToolProfileResolution {
  /** The single matching profile, or `undefined` when there is none or the tool name is ambiguous (never guessed). */
  profile: SubagentProfile | undefined;
  /** `true` when 2+ profiles register this exact tool name (SUBAGENT-REQ-005). */
  ambiguous: boolean;
  candidates: SubagentProfile[];
}

/**
 * SUBAGENT-REQ-005: resolve which profile should be used to open/read a
 * subagent span for a given tool name. Exactly one match resolves
 * unambiguously; zero means this is not a recognised subagent tool call at
 * all; two or more (e.g. `"subagent"`, registered by both the pi reference
 * example and pi-subagents) is a genuine name collision — never guessed:
 * `profile` stays `undefined` and `ambiguous` is `true` so the caller can
 * still open a best-effort span (see `readLaunchInfo`/`readResultInfo`)
 * without ever claiming a specific profile matched.
 */
export function resolveToolProfile(profiles: readonly SubagentProfile[], toolName: string): ToolProfileResolution {
  const candidates = matchToolProfiles(profiles, toolName);
  if (candidates.length === 1) return { profile: candidates[0], ambiguous: false, candidates };
  if (candidates.length === 0) return { profile: undefined, ambiguous: false, candidates };
  return { profile: undefined, ambiguous: true, candidates };
}

/** Every tool name registered by 2+ profiles at once, with the colliding profile ids — a static property of the active profile set, independent of any record. */
export function findAmbiguousToolNames(profiles: readonly SubagentProfile[]): Array<{ toolName: string; profileIds: string[] }> {
  const byTool = new Map<string, string[]>();
  for (const profile of profiles) {
    for (const toolName of profile.toolNames) {
      const ids = byTool.get(toolName) ?? [];
      ids.push(profile.id);
      byTool.set(toolName, ids);
    }
  }
  const ambiguous: Array<{ toolName: string; profileIds: string[] }> = [];
  for (const [toolName, profileIds] of byTool) {
    if (profileIds.length > 1) ambiguous.push({ toolName, profileIds });
  }
  return ambiguous;
}

/** Best-effort merge of `readLaunchArgs` across several candidate profiles (an ambiguous tool-name match): first defined field, in profile order, wins. */
export function readLaunchInfo(candidates: readonly SubagentProfile[], args: Record<string, unknown> | undefined): SubagentLaunchInfo {
  let agent: string | undefined;
  let mode: string | undefined;
  for (const profile of candidates) {
    const info = profile.readLaunchArgs(args);
    if (agent === undefined && info.agent !== undefined) agent = info.agent;
    if (mode === undefined && info.mode !== undefined) mode = info.mode;
  }
  return { ...(agent !== undefined ? { agent } : {}), ...(mode !== undefined ? { mode } : {}) };
}

/** Best-effort merge of `readResult` across several candidate profiles (an ambiguous tool-name match): first defined field, in profile order, wins — never a profile-specific field none of the candidates actually provided. */
export function readResultInfo(candidates: readonly SubagentProfile[], result: unknown): SubagentResultInfo {
  const merged: SubagentResultInfo = {};
  for (const profile of candidates) {
    const info = profile.readResult(result);
    if (merged.taskId === undefined && info.taskId !== undefined) merged.taskId = info.taskId;
    if (merged.agent === undefined && info.agent !== undefined) merged.agent = info.agent;
    if (merged.status === undefined && info.status !== undefined) merged.status = info.status;
    if (merged.mode === undefined && info.mode !== undefined) merged.mode = info.mode;
    if (merged.cwd === undefined && info.cwd !== undefined) merged.cwd = info.cwd;
    if (merged.usage === undefined && info.usage !== undefined) merged.usage = info.usage;
  }
  return merged;
}

/**
 * Whether any of `markers` is present in `env`: an exact-value marker
 * requires an exact match, a presence-only marker (`value: undefined`)
 * matches any non-empty value. Shared by `profileMarkerMatches` (one
 * profile's own markers) and `config.ts#detectRole` (the full active set,
 * generalised beyond the single hardcoded `GENTLE_PI_AGENTS_CHILD` check).
 */
export function matchesAnyMarker(env: NodeJS.ProcessEnv, markers: readonly ChildEnvMarker[]): boolean {
  return markers.some((marker) => {
    const actual = env[marker.name];
    if (actual === undefined || actual === "") return false;
    return marker.value === undefined || actual === marker.value;
  });
}

/** Whether `profile`'s child-env marker(s) are present in `env`. A profile with no markers at all (e.g. `PI_REFERENCE_PROFILE`) never matches, by construction. */
export function profileMarkerMatches(profile: SubagentProfile, env: NodeJS.ProcessEnv): boolean {
  return matchesAnyMarker(env, profile.childEnvMarkers);
}

export interface ChildProfileResolution {
  /** The single profile confirmed by an env marker, or `undefined` when none matched or 2+ matched at once (never guessed). */
  profile: SubagentProfile | undefined;
  matchedProfiles: SubagentProfile[];
}

/**
 * SUBAGENT-REQ-005: resolve which profile's child-env marker(s) confirm
 * THIS process as a subagent of a known kind — the child-side counterpart
 * of `resolveToolProfile`. Exactly one profile's marker present resolves
 * unambiguously; none present means this process's role, if any, must come
 * from ancestry instead (see `config.ts#detectRole`); two or more present
 * at once (a genuine marker collision, not expected among the built-ins) is
 * never guessed either — `profile` stays `undefined`, but every match is
 * still reported so `/kankaku doctor` can surface it.
 */
export function resolveChildProfile(profiles: readonly SubagentProfile[], env: NodeJS.ProcessEnv): ChildProfileResolution {
  const matchedProfiles = profiles.filter((profile) => profileMarkerMatches(profile, env));
  return { profile: matchedProfiles.length === 1 ? matchedProfiles[0] : undefined, matchedProfiles };
}

/** Every distinct child-env marker declared by any of `profiles`, de-duplicated by `name` (first-declared value wins) — used to generalise `detectRole`'s single hardcoded marker check. */
export function allChildMarkers(profiles: readonly SubagentProfile[]): ChildEnvMarker[] {
  const byName = new Map<string, ChildEnvMarker>();
  for (const profile of profiles) {
    for (const marker of profile.childEnvMarkers) {
      if (!byName.has(marker.name)) byName.set(marker.name, marker);
    }
  }
  return Array.from(byName.values());
}
