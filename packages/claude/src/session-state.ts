import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PromptOpenState {
  id: string;
  startedAt: number;
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
  return isSessionState(parsed) ? parsed : undefined;
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
