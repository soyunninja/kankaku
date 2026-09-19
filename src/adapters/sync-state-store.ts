/**
 * Disk-backed store for `<KANKAKU_DIR>/sync-state.json`, plus a simple
 * cross-process lock so two pi processes (e.g. an orchestrator's
 * auto-sync and a manual `/kankaku sync` in another terminal) never sync
 * the same directory concurrently. Mirrors `file-inflight-store.ts`'s
 * atomic-write and liveness-probe conventions.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncState } from "../domain/sync-plan.ts";

const STATE_FILE_NAME = "sync-state.json";
const LOCK_FILE_NAME = "sync.lock";
/** A lock older than this is considered abandoned even if its owning pid still (coincidentally) exists. */
const STALE_LOCK_MS = 5 * 60 * 1000;

interface LockFile {
  pid: number;
  at: number;
}

function isSyncState(value: unknown): value is SyncState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["target"] === "string" &&
    typeof record["hashes"] === "object" &&
    record["hashes"] !== null &&
    (record["syncedThrough"] === undefined || typeof record["syncedThrough"] === "string")
  );
}

function isLockFile(value: unknown): value is LockFile {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record["pid"] === "number" && typeof record["at"] === "number";
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Best effort: already removed, or never existed.
  }
}

export interface SyncStateStoreDeps {
  dir: string;
  pid: number;
  /** Whether a pid is still alive. Defaults to the same signal-probe used elsewhere. */
  isAlive?: (pid: number) => boolean;
  /** Injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * `read()`/`write()` tolerate a missing or malformed file (return
 * `undefined` / overwrite, respectively) since this state is disposable —
 * losing it only costs a full re-evaluation on the next sync, never data.
 * `tryLock()`/`unlock()` implement a simple pid+timestamp lock file, stale
 * after {@link STALE_LOCK_MS}.
 */
export class SyncStateStore {
  private readonly deps: Required<SyncStateStoreDeps>;

  constructor(deps: SyncStateStoreDeps) {
    this.deps = {
      dir: deps.dir,
      pid: deps.pid,
      isAlive: deps.isAlive ?? defaultIsAlive,
      now: deps.now ?? (() => Date.now()),
    };
  }

  private get statePath(): string {
    return join(this.deps.dir, STATE_FILE_NAME);
  }

  private get lockPath(): string {
    return join(this.deps.dir, LOCK_FILE_NAME);
  }

  read(): SyncState | undefined {
    try {
      if (!existsSync(this.statePath)) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      return isSyncState(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  write(state: SyncState): void {
    mkdirSync(this.deps.dir, { recursive: true });
    atomicWrite(this.statePath, JSON.stringify(state));
  }

  /**
   * Try to acquire the cross-process sync lock. Returns `true` (and takes
   * ownership) when there is no lock file, the existing one's pid is no
   * longer alive, or it is older than {@link STALE_LOCK_MS}; `false` when a
   * live, fresh lock is held by another process.
   */
  tryLock(): boolean {
    mkdirSync(this.deps.dir, { recursive: true });

    const existing = this.readLock();
    if (existing && existing.pid !== this.deps.pid) {
      const age = this.deps.now() - existing.at;
      const staleByAge = age > STALE_LOCK_MS;
      const staleByLiveness = !this.deps.isAlive(existing.pid);
      if (!staleByAge && !staleByLiveness) return false;
    }

    atomicWrite(this.lockPath, JSON.stringify({ pid: this.deps.pid, at: this.deps.now() }));
    return true;
  }

  /** Release the lock, but only if this process still owns it (never clobber someone else's fresher lock). */
  unlock(): void {
    const existing = this.readLock();
    if (existing && existing.pid === this.deps.pid) {
      safeUnlink(this.lockPath);
    }
  }

  private readLock(): LockFile | undefined {
    try {
      if (!existsSync(this.lockPath)) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(this.lockPath, "utf8"));
      return isLockFile(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Default `isAlive`: probe with signal 0 — mirrors `pi-tracker.ts`'s default. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
