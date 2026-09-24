import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PromptOpenState {
  id: string;
  startedAt: number;
  costAtStart: number | undefined;
}

export interface CostState {
  totalUsd: number;
  updatedAt: number;
  model?: string;
}

/** `<claude/>/<session_id>.state.json` — small, rewritten atomically. */
export interface SessionState {
  pid: number;
  parentPid: number;
  cwd: string;
  startedAt: number;
  promptOpen: PromptOpenState | null;
  cost: CostState | null;
  permissionOpen: number | null;
}

function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.pid === "number" &&
    typeof o.parentPid === "number" &&
    typeof o.cwd === "string" &&
    typeof o.startedAt === "number" &&
    "promptOpen" in o &&
    "cost" in o &&
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

/**
 * Touches ONLY the `cost` field, never lowering `updatedAt`: a statusline
 * write that races with a hook's own state write is safe as long as both
 * writers only ever narrow their change to the field they own. When no
 * state file exists yet, creates a minimal shell (`pid`/`parentPid`
 * unresolved) — the next hook to run fills in the rest.
 */
export function mergeCost(file: string, cost: CostState): void {
  updateState(file, (state) => {
    if (!state) {
      return {
        pid: 0,
        parentPid: 0,
        cwd: "",
        startedAt: cost.updatedAt,
        promptOpen: null,
        cost,
        permissionOpen: null,
      };
    }
    if (state.cost && state.cost.updatedAt > cost.updatedAt) return state;
    return { ...state, cost };
  });
}
