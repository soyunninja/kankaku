import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Only the field this module actually needs from `process.env`. */
export interface CostEnv {
  HOME?: string;
}

export interface CostState {
  totalUsd: number;
  updatedAt: number;
  model?: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cost lives under the HOME directory, never a project: the statusline
 * command is wired globally and runs in every session on the machine, so a
 * project-relative path would litter whatever project happens to be open
 * (the defect this module fixes — see `odd/tasks/hook-tracking.md` T7).
 * Imports only node builtins so light hooks that read/write cost stay off
 * the `kankaku-pi` import path.
 */
export function costDir(env: CostEnv): string {
  const home = env.HOME || homedir();
  return join(home, ".kankaku", "claude", "cost");
}

export function costFile(env: CostEnv, sessionId: string): string {
  return join(costDir(env), `${sessionId}.json`);
}

function isCostState(value: unknown): value is CostState {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.totalUsd === "number" &&
    typeof o.updatedAt === "number" &&
    (o.model === undefined || typeof o.model === "string")
  );
}

/** `undefined` when the file is absent or its contents are malformed. */
export function readCost(env: CostEnv, sessionId: string): CostState | undefined {
  let text: string;
  try {
    text = readFileSync(costFile(env, sessionId), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isCostState(parsed) ? parsed : undefined;
}

/**
 * Atomic tmp+rename write. Creates `claude/` and `claude/cost/` (both owned
 * exclusively by this plugin) as owner-only (`0700`) when it creates them —
 * `mkdirSync`'s `mode` only ever applies to a directory the call actually
 * creates, so an existing `~/.kankaku` is never chmod'd by this. The written
 * file is chmod'd `0600` best-effort. Never lowers `updatedAt`: a statusline
 * write racing an older one loses.
 */
export function writeCost(env: CostEnv, sessionId: string, cost: CostState): void {
  const dir = costDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const existing = readCost(env, sessionId);
  if (existing && existing.updatedAt > cost.updatedAt) return;

  const file = costFile(env, sessionId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(cost));
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
}

export function deleteCost(env: CostEnv, sessionId: string): void {
  try {
    unlinkSync(costFile(env, sessionId));
  } catch {
    // already gone
  }
}

export interface SweepStaleCostFilesOptions {
  now: number;
  maxAgeMs?: number;
}

/**
 * Deletes cost files whose `updatedAt` (or mtime, when the file is
 * unparsable) is older than `maxAgeMs` (default 7 days). No-op when the
 * cost directory does not exist yet.
 */
export function sweepStaleCostFiles(env: CostEnv, opts: SweepStaleCostFilesOptions): void {
  const maxAgeMs = opts.maxAgeMs ?? SEVEN_DAYS_MS;
  const dir = costDir(env);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const sessionId = name.slice(0, -".json".length);
    const cost = readCost(env, sessionId);
    let age: number;
    if (cost) {
      age = opts.now - cost.updatedAt;
    } else {
      try {
        age = opts.now - statSync(file).mtimeMs;
      } catch {
        continue;
      }
    }
    if (age > maxAgeMs) {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    }
  }
}
