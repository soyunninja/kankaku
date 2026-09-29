import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkRecordCore } from "kankaku-pi/domain";
import type { TranscriptPosition } from "./transcript.ts";

export interface PromptOpenState {
  id: string;
  startedAt: number;
  costAtStart: number | undefined;
}

/**
 * What the plugin knows about the session's Claude Code transcript. Every
 * field is numbers, paths or short identifiers; no transcript content.
 */
export interface TranscriptState {
  /** The main transcript, from the hook input's `transcript_path`. */
  path: string;
  /** Read position per transcript file (the main one and every subagent file); advances only at settle. */
  offsets: Record<string, TranscriptPosition>;
  /** Claude Code's version, from the transcript, once seen. */
  agentVersion?: string;
  /** `cli` (interactive) or `sdk-cli` (headless `claude -p`), from the transcript, once seen. */
  entrypoint?: string;
  /** `message.model` of the last assistant line read; the record's model when the statusline gave none. */
  model?: string;
}

/** A settled prompt of a headless session, held until `SessionEnd` (or recovery) knows the session cost. */
export interface PendingPrompt {
  /** The replayed record, times and tokens final, cost not yet known. */
  core: WorkRecordCore;
  /** The cost baseline this prompt was measured from (see `PromptOpenState.costAtStart`). */
  costAtStart: number | undefined;
}

/**
 * `<claude/>/<session_id>.state.json` — small, rewritten atomically. Cost is
 * NOT a field here (since T7, `odd/tasks/hook-tracking.md`): it lives under
 * `~/.kankaku/claude/cost/` (`src/cost-store.ts`), never in a project's
 * state file — only the hooks write this file.
 */
export interface SessionState {
  pid: number;
  parentPid: number;
  cwd: string;
  startedAt: number;
  promptOpen: PromptOpenState | null;
  permissionOpen: number | null;
  /**
   * The session's cost total (USD) at its last settle: the chain that makes
   * spend between two prompts land in the next record. Optional, so a state
   * file written before it existed stays valid.
   */
  costBaseline?: number;
  /** Transcript path, read positions and what was learned from it. Optional: an older state file stays valid. */
  transcript?: TranscriptState;
  /** Headless prompts settled at `Stop` whose records wait for the session cost. Optional. */
  pending?: PendingPrompt[];
}

/**
 * A legacy state file written before T7 may still carry a `cost` field; an
 * extra field is harmless (never required, never round-tripped by
 * `writeState`), so it is not rejected here.
 */
function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.pid === "number" &&
    typeof o.parentPid === "number" &&
    typeof o.cwd === "string" &&
    typeof o.startedAt === "number" &&
    "promptOpen" in o &&
    "permissionOpen" in o
  );
}

/** `undefined` when the file is absent or its contents are malformed. */
export function readState(file: string): SessionState | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isSessionState(parsed) ? withoutInvalidOptionals(parsed) : undefined;
}

/** The optional transcript fields are advisory: a malformed one is dropped, never the whole state. */
function withoutInvalidOptionals(state: SessionState): SessionState {
  const { transcript, pending, ...rest } = state as SessionState & Record<string, unknown>;
  return {
    ...rest,
    ...(isTranscriptState(transcript) ? { transcript } : {}),
    ...(Array.isArray(pending) && pending.every(isPendingPrompt) ? { pending } : {}),
  };
}

function isTranscriptState(value: unknown): value is TranscriptState {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.path !== "string" || typeof o.offsets !== "object" || o.offsets === null) return false;
  if (o.agentVersion !== undefined && typeof o.agentVersion !== "string") return false;
  if (o.entrypoint !== undefined && typeof o.entrypoint !== "string") return false;
  if (o.model !== undefined && typeof o.model !== "string") return false;
  return Object.values(o.offsets).every((position) => {
    if (typeof position !== "object" || position === null) return false;
    const p = position as Record<string, unknown>;
    return (
      typeof p.bytes === "number" &&
      Number.isFinite(p.bytes) &&
      p.bytes >= 0 &&
      (p.lastMessageId === undefined || typeof p.lastMessageId === "string") &&
      (p.lastMessageUsage === undefined || isTokenUsage(p.lastMessageUsage))
    );
  });
}

function isTokenUsage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const u = value as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof u[key] === "number" && Number.isFinite(u[key]) && (u[key] as number) >= 0);
}

function isPendingPrompt(value: unknown): value is PendingPrompt {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.core === "object" &&
    o.core !== null &&
    typeof (o.core as Record<string, unknown>).id === "string" &&
    (o.costAtStart === undefined || o.costAtStart === null || typeof o.costAtStart === "number")
  );
}

/** Atomic tmp+rename write, creating parent directories as needed. */
export function writeState(file: string, state: SessionState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}

/** Read-modify-write: `fn` receives the current state (`undefined` if absent) and returns the next one. */
export function updateState(file: string, fn: (state: SessionState | undefined) => SessionState): void {
  writeState(file, fn(readState(file)));
}
