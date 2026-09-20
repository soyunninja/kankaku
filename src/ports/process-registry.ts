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
   * sweeps entries whose owning pid is no longer alive (per `isAlive`,
   * defaulting to a signal-probe), so the registry does not grow unbounded
   * (SUBAGENT-REQ-010). Never throws.
   */
  record(entry: RegistryEntry, isAlive?: (pid: number) => boolean): void;
  /** Every currently-persisted entry, tolerating a corrupt/torn file by skipping it. Never throws; returns `[]` when the registry is unavailable. */
  readAll(): RegistryEntry[];
}
