import type { WorkRecord } from "../domain/work-record.ts";
import type { ProcessRegistry } from "../ports/process-registry.ts";
import type { WorkLog } from "../ports/work-log.ts";

export interface RegistryAwareWorkLogDeps {
  /** The real, local, per-project log this process appends to and normally reads. */
  inner: WorkLog;
  registry: ProcessRegistry;
  /** Read every record from another process's kankaku dir (an absolute path, from a `RegistryEntry.dir`). Must never throw — return `[]` on any failure. */
  readForeignRecords: (dir: string) => WorkRecord[];
}

/**
 * {@link WorkLog} decorator that reunites a gentle-pi cross-worktree
 * subagent with its orchestrator locally, before any consumer's own
 * `buildTasks` call (ADR 0023). `append`/`version` pass straight through
 * to `inner`; `readAll` additionally merges in any subagent record a
 * *confirmed* local orchestrator can be shown, via the machine-wide
 * registry, to actually own — even though that record lives in a
 * different project's `worklog.jsonl` and would otherwise never be read at
 * all. `matchChildren` (`domain/task-view.ts`) still does 100% of the
 * actual joining/union math on the resulting array — this class only ever
 * expands what is *visible*, never re-implementing aggregation (ADR 0006).
 *
 * A registry-discovered candidate is only merged when its own
 * `orchestratorRef` exactly identifies this local orchestrator (`pid` +
 * `project` + `startedAt`), so an unrelated registry entry — including one
 * from a stale/reused pid — can never be pulled in by accident; a
 * same-project child is left alone here since it is already visible via
 * `inner.readAll()`.
 */
export class RegistryAwareWorkLog implements WorkLog {
  private readonly deps: RegistryAwareWorkLogDeps;

  constructor(deps: RegistryAwareWorkLogDeps) {
    this.deps = deps;
  }

  append(record: WorkRecord): void {
    this.deps.inner.append(record);
  }

  version(): string | number {
    // Falls back to a constant when `inner` has no version signal of its
    // own — never wrong, just never useful for cache invalidation in that
    // case, exactly as an absent `version()` would be (see `ports/work-log.ts`).
    return this.deps.inner.version?.() ?? "";
  }

  readAll(): WorkRecord[] {
    const local = this.deps.inner.readAll();
    const orchestrators = local.filter((record) => record.role === "orchestrator" && record.roleConfidence !== "uncertain");
    if (orchestrators.length === 0) return local;

    let entries;
    try {
      entries = this.deps.registry.readAll();
    } catch {
      return local;
    }

    const foreignEntries = entries.filter((entry) => entry.role === "subagent" && entry.orchestratorRef !== undefined);
    if (foreignEntries.length === 0) return local;

    const seenIds = new Set(local.map((record) => record.id));
    const merged = [...local];
    const readForeignDirs = new Map<string, WorkRecord[]>();

    for (const orchestrator of orchestrators) {
      for (const entry of foreignEntries) {
        if (entry.project === orchestrator.project) continue; // already visible via inner.readAll()
        const ref = entry.orchestratorRef!;
        if (ref.pid !== orchestrator.pid || ref.project !== orchestrator.project || ref.startedAt !== orchestrator.startedAt) continue;

        let foreignRecords = readForeignDirs.get(entry.dir);
        if (foreignRecords === undefined) {
          foreignRecords = this.safeReadForeign(entry.dir);
          readForeignDirs.set(entry.dir, foreignRecords);
        }

        for (const record of foreignRecords) {
          if (record.role !== "subagent" || record.pid !== entry.pid || seenIds.has(record.id)) continue;
          seenIds.add(record.id);
          merged.push(record);
        }
      }
    }

    return merged;
  }

  private safeReadForeign(dir: string): WorkRecord[] {
    try {
      return this.deps.readForeignRecords(dir);
    } catch {
      return [];
    }
  }
}
