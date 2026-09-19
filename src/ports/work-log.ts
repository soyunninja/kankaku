import type { WorkRecord } from "../domain/work-record.ts";

export interface WorkLog {
  append(record: WorkRecord): void;
  readAll(): WorkRecord[];
  /**
   * Optional cheap change signal: a value that changes whenever `append()`
   * would change what `readAll()` returns, computable without reading the
   * whole log (e.g. from file stat metadata). Callers that cache a view
   * derived from `readAll()` (see `pi-tracker.ts`'s client-name completion
   * cache) may use this to invalidate cheaply; a `WorkLog` that omits it
   * simply leaves such callers relying on their own explicit invalidation.
   */
  version?(): string | number;
}
