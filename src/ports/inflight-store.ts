import type { WorkRecord } from "../domain/work-record.ts";

/**
 * Crash-recovery checkpoint store: one process periodically saves the
 * record its {@link WorkTracker} would produce right now, so a hard crash
 * (kill -9, power loss) still leaves a record behind — recovered as
 * `interrupted` on the next pi start rather than lost entirely.
 */
export interface InflightStore {
  /** Upsert this process's checkpoint. */
  save(record: WorkRecord): void;
  /** Remove this process's checkpoint (normal settle/shutdown). */
  clear(): void;
  /** Return and delete every checkpoint whose owning pid is no longer alive. */
  recoverStale(isAlive: (pid: number) => boolean): WorkRecord[];
}
