/**
 * Disk-backed store for `<KANKAKU_DIR>/sync-state.json`, plus a simple
 * cross-process lock so two pi processes (e.g. an orchestrator's
 * auto-sync and a manual `/kankaku sync` in another terminal) never sync
 * the same directory concurrently. Mirrors `file-inflight-store.ts`'s
 * atomic-write and liveness-probe conventions.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

/** The subset of `node:fs` the lock's acquire/recover path needs, injectable so tests can simulate cross-process interleaving deterministically. */
export interface SyncStateStoreFsOps {
  existsSync: typeof existsSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  openSync: typeof openSync;
  closeSync: typeof closeSync;
}

const defaultFsOps: SyncStateStoreFsOps = { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync };

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
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

function safeUnlink(fs: Pick<SyncStateStoreFsOps, "unlinkSync">, filePath: string): void {
  try {
    fs.unlinkSync(filePath);
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
  /** Injectable `node:fs` primitives for the lock's acquire/recover path. Defaults to the real ones. */
  fs?: SyncStateStoreFsOps;
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
      fs: deps.fs ?? defaultFsOps,
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
   * Try to acquire the cross-process sync lock. Acquisition itself is
   * atomic: it always goes through an exclusive create ({@link acquireFresh},
   * `open` with the `wx` flag), never a read-then-write, so two processes
   * racing to create the lock file can never both succeed. Returns `true`
   * (and takes ownership) when there is no lock file, this process already
   * owns it (re-entrant), or the existing one is stale (its pid is no
   * longer alive, or it is older than {@link STALE_LOCK_MS}) and this
   * process wins the race to recover it; `false` when a live, fresh lock is
   * held by another process, or this process loses a stale-lock recovery
   * race to another one.
   */
  tryLock(): boolean {
    mkdirSync(this.deps.dir, { recursive: true });

    if (this.acquireFresh()) return true;

    const existing = this.readLock();
    if (!existing) {
      // Raced with a release between our failed create and this read; the
      // slot may be free again now. One more attempt, then give up rather
      // than looping forever.
      return this.acquireFresh();
    }

    if (existing.pid === this.deps.pid) return true; // re-entrant: we already own it.

    const age = this.deps.now() - existing.at;
    const stale = age > STALE_LOCK_MS || !this.deps.isAlive(existing.pid);
    if (!stale) return false; // live, fresh lock held by someone else.

    // Stale-lock recovery, made race-safe: rename the stale file to a
    // unique tombstone name first. `rename` is atomic, so only one racer's
    // call can succeed; every loser gets ENOENT and backs off instead of
    // deleting (or overwriting) a lock it never proved was still stale.
    const tombstone = `${this.lockPath}.stale.${this.deps.pid}.${this.deps.now()}.tmp`;
    try {
      this.deps.fs.renameSync(this.lockPath, tombstone);
    } catch (error) {
      if (isEnoent(error)) return false; // lost the recovery race; back off.
      throw error;
    }
    safeUnlink(this.deps.fs, tombstone);

    return this.acquireFresh(); // false here means a third racer won it first.
  }

  /** Create the lock file exclusively (`wx`): fails with EEXIST when another lock already exists, never silently overwrites one. Assumes `this.deps.dir` already exists (`tryLock` ensures it once up front). */
  private acquireFresh(): boolean {
    let fd: number;
    try {
      fd = this.deps.fs.openSync(this.lockPath, "wx");
    } catch (error) {
      if (isEexist(error)) return false;
      throw error;
    }
    try {
      this.deps.fs.writeFileSync(fd, JSON.stringify({ pid: this.deps.pid, at: this.deps.now() }));
    } catch (error) {
      try {
        this.deps.fs.closeSync(fd);
      } catch {
        // Best effort: still try to clean up the partially written file below.
      }
      safeUnlink(this.deps.fs, this.lockPath);
      throw error;
    }
    this.deps.fs.closeSync(fd);
    return true;
  }

  /** Release the lock, but only if this process still owns it (never clobber someone else's fresher lock). */
  unlock(): void {
    const existing = this.readLock();
    if (existing && existing.pid === this.deps.pid) {
      safeUnlink(this.deps.fs, this.lockPath);
    }
  }

  private readLock(): LockFile | undefined {
    try {
      if (!this.deps.fs.existsSync(this.lockPath)) return undefined;
      const parsed: unknown = JSON.parse(this.deps.fs.readFileSync(this.lockPath, "utf8"));
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
