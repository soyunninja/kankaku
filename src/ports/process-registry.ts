import type { OrchestratorRef, WorkRole } from "../domain/work-record.ts";

/**
 * One machine-wide, live-process registry entry
 * (`~/.kankaku/run/<pid>.json`, see `adapters/machine-process-registry.ts`),
 * independent of any project's `KANKAKU_DIR` (ADR 0023). Written by every
 * kankaku process at extension-factory time, so a later process (a child,
 * possibly in another worktree) can discover it by walking its own OS
 * ancestor chain.
 */
export interface RegistryEntry {
  pid: number;
  parentPid: number;
  role: WorkRole;
  /** This process's own cwd at the time it wrote this entry. A hint for matching, never a hard filter (ADR 0021). */
  project: string;
  /** Absolute, resolved `KANKAKU_DIR` for this process, so another process can read its `worklog.jsonl` directly without guessing at a shared relative directory name. */
  dir: string;
  startedAt: string;
  /** The tracked ancestor this process itself discovered via the same registry, when any. */
  orchestratorRef?: OrchestratorRef;
  /**
   * This process's own OS-reported start-time identity, as an
   * approximate-but-self-consistent epoch-ms estimate (see
   * `adapters/ancestry.ts`). Used to prove — not just guess by pid number
   * — that a later reader's ancestor pid is still the *same* process
   * instance this entry was written for, since the OS reuses pids
   * (`domain/ancestry-match.ts#findAncestorEntry`). `undefined` when this
   * process could not obtain it (Windows, or any read failure) — such an
   * entry can never be trusted for identity matching and is swept as
   * unverifiable (see `domain/registry-health.ts`).
   */
  processStartId?: number;
}

/** Extra, optional dependencies for {@link ProcessRegistry.record}'s opportunistic sweep. See `domain/registry-health.ts`. */
export interface RegistrySweepDeps {
  /** Live start identity for a pid, from the same ancestry snapshot this process already took at startup. `undefined` means "unknown" — such a pid is never swept as stale-by-reuse (fails safe). Defaults to always-unknown. */
  liveStartId?: (pid: number) => number | undefined;
  /** Defaults to `Date.now()`. Injectable for deterministic tests. */
  now?: number;
}

/**
 * Machine-wide registry of live (or recently-live) kankaku processes.
 * Every operation is expected to degrade gracefully — an unavailable home
 * directory or any filesystem failure yields an empty read / a no-op write
 * rather than throwing, since this is an enhancement to subagent detection
 * and must never block or crash the extension it improves.
 */
export interface ProcessRegistry {
  /**
   * Upsert this process's own entry, atomically. Also opportunistically
   * sweeps entries the registry can no longer trust it should keep — dead
   * pids, entries whose recorded identity no longer matches the live
   * process holding that pid (pid reuse), entries with no verifiable
   * identity at all (legacy/malformed), and entries older than a sane
   * maximum age — so `run/` does not grow unbounded and never serves a
   * stale identity (SUBAGENT-REQ-010, and the PID-reuse fix). Never
   * removes the entry this call itself just wrote. Never throws.
   */
  record(entry: RegistryEntry, isAlive?: (pid: number) => boolean, sweepDeps?: RegistrySweepDeps): void;
  /** Every currently-persisted entry, tolerating a corrupt/torn file by skipping it. Never throws; returns `[]` when the registry is unavailable. */
  readAll(): RegistryEntry[];
  /**
   * Best-effort remove of this process's *own* entry file
   * (`session_shutdown`, process `exit`). Reads the on-disk entry back
   * first and only unlinks it when both `pid` and `processStartId` still
   * match exactly what is on disk — so a file already overwritten by a
   * pid-reuse successor (unlikely, but never assumed away) is never
   * touched. Optional: an older `ProcessRegistry` implementation (e.g. a
   * test fake) may omit it; callers must guard the call. Never throws.
   */
  removeOwn?(pid: number, processStartId: number | undefined): void;
}
