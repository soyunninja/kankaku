/**
 * Orchestrates one sync run: read every record, build tasks (never
 * re-implementing the aggregation — `buildTasks` is the only place it
 * lives), plan what needs pushing, push it, and persist the new state.
 * Never throws to its caller: every failure mode is folded into the
 * returned {@link SyncSummary}.
 */

import { buildTasks } from "../domain/task-view.ts";
import { computeTaskContentHash, planSync, pruneHashes } from "../domain/sync-plan.ts";
import type { TaskView } from "../domain/task-view.ts";
import type { Clock } from "../ports/clock.ts";
import type { WorkLog } from "../ports/work-log.ts";
import type { WorkSink } from "../ports/work-sink.ts";
import type { SyncStateStore } from "./sync-state-store.ts";

export interface SyncSummary {
  uploaded: number;
  updated: number;
  skipped: number;
  failed: Array<{ id: string; reason: string }>;
  /** Count of tasks routed to the unassigned client this run, grouped by their historical free-text label. */
  unassigned: Record<string, number>;
  syncedThrough: string | undefined;
  durationMs: number;
  /** Set when a network/timeout/5xx/auth failure stopped the run before every candidate task was attempted. */
  error?: string;
  /** `true` when another sync already holds the lock; nothing was attempted this run. */
  locked?: boolean;
}

export interface SyncRunnerDeps {
  log: WorkLog;
  sink: WorkSink;
  stateStore: SyncStateStore;
  clock: Clock;
  /** The configured hub URL — a state file synced against a different one triggers a full sync. */
  target: string;
  windowHours?: number;
}

const NO_LABEL = "(no label)";

/** The later of two ISO timestamps, treating `undefined` as earlier than anything. */
function laterIso(a: string | undefined, b: string): string {
  if (a === undefined) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function emptySummary(durationMs: number, syncedThrough: string | undefined): SyncSummary {
  return { uploaded: 0, updated: 0, skipped: 0, failed: [], unassigned: {}, syncedThrough, durationMs };
}

/**
 * Run one sync pass. Acquires the cross-process lock for the whole run
 * (never held across `await` boundaries outside this function) so two pi
 * processes never race on the same `sync-state.json`.
 */
export async function runSync(deps: SyncRunnerDeps, options: { full?: boolean } = {}): Promise<SyncSummary> {
  const startedAt = deps.clock.now();

  let lockAcquired = false;
  try {
    lockAcquired = deps.stateStore.tryLock();
    if (!lockAcquired) {
      const state = deps.stateStore.read();
      return { ...emptySummary(deps.clock.now() - startedAt, state?.syncedThrough), locked: true };
    }

    const state = deps.stateStore.read();
    const tasks = buildTasks(deps.log.readAll());
    const plan = planSync(tasks, state, { target: deps.target, ...(deps.windowHours !== undefined ? { windowHours: deps.windowHours } : {}), ...(options.full !== undefined ? { full: options.full } : {}) });

    let results: Awaited<ReturnType<WorkSink["push"]>>;
    try {
      results = await deps.sink.push(plan.toSync);
    } catch (error) {
      // WorkSink implementations are expected never to throw, but this
      // runner must hold that guarantee even if one does.
      const message = error instanceof Error ? error.message : String(error);
      const summary = emptySummary(deps.clock.now() - startedAt, state?.syncedThrough);
      summary.skipped = plan.unchangedCount;
      summary.error = message;
      persistError(deps, state, message);
      return summary;
    }

    const byId = new Map(plan.toSync.map((task) => [task.id, task]));
    const newHashes: Record<string, string> = {};
    const failed: Array<{ id: string; reason: string }> = [];
    const unassigned: Record<string, number> = {};
    let uploaded = 0;
    let updated = 0;
    let syncedThrough = state?.syncedThrough;
    let stopError: string | undefined;
    // Whether at least one task was actually resolved (pushed or recorded
    // as failed) this run — as opposed to the run stopping on its very
    // first attempt. Guards `target` below: a run against a new/unreachable
    // target that resolves nothing must not overwrite the state's `target`,
    // or a later sync against the *real* target would wrongly see it as
    // unchanged and skip the full re-evaluation it needs.
    let progressed = false;

    for (const result of results) {
      const task = byId.get(result.taskId);
      if (!task) continue; // defensive: a WorkSink implementation misbehaving should not crash the runner.

      if (result.outcome.kind === "created" || result.outcome.kind === "updated") {
        if (result.outcome.kind === "created") uploaded += 1;
        else updated += 1;
        newHashes[task.id] = computeTaskContentHash(task);
        syncedThrough = laterIso(syncedThrough, task.endedAt);
        progressed = true;
        if (result.outcome.unassigned) {
          const label = result.outcome.legacyLabel || NO_LABEL;
          unassigned[label] = (unassigned[label] ?? 0) + 1;
        }
      } else if (result.outcome.kind === "failed") {
        // Recorded and skipped, not retried forever: stamp its hash too so
        // an unchanged, permanently-invalid task is not resent every run.
        failed.push({ id: task.id, reason: result.outcome.reason });
        newHashes[task.id] = computeTaskContentHash(task);
        syncedThrough = laterIso(syncedThrough, task.endedAt);
        progressed = true;
      } else {
        // "error": a network/timeout/5xx/auth failure. Stop here — nothing
        // after this point in the (chronologically sorted) results is
        // considered resolved, so syncedThrough does not advance past it.
        stopError = result.outcome.reason;
        break;
      }
    }

    const mergedHashes = { ...(state?.hashes ?? {}), ...newHashes };
    const prunedHashes = pruneHashes(mergedHashes, tasks, syncedThrough, deps.windowHours);
    // Only adopt deps.target as the persisted target once this run has
    // actually resolved something against it; otherwise keep whatever
    // target (if any) the previous state was synced against.
    const persistedTarget = progressed || state === undefined ? deps.target : state.target;

    deps.stateStore.write({
      target: persistedTarget,
      ...(syncedThrough !== undefined ? { syncedThrough } : {}),
      hashes: prunedHashes,
      ...(stopError !== undefined ? { lastError: { message: stopError, at: new Date(deps.clock.now()).toISOString() } } : {}),
    });

    return {
      uploaded,
      updated,
      skipped: plan.unchangedCount,
      failed,
      unassigned,
      syncedThrough,
      durationMs: deps.clock.now() - startedAt,
      ...(stopError !== undefined ? { error: stopError } : {}),
    };
  } finally {
    if (lockAcquired) deps.stateStore.unlock();
  }
}

function persistError(deps: SyncRunnerDeps, state: ReturnType<SyncStateStore["read"]>, message: string): void {
  deps.stateStore.write({
    target: deps.target,
    ...(state?.syncedThrough !== undefined ? { syncedThrough: state.syncedThrough } : {}),
    hashes: state?.hashes ?? {},
    lastError: { message, at: new Date(deps.clock.now()).toISOString() },
  });
}

/** Number of tasks pending a sync right now, for `/kankaku sync status` — computed locally, no network. */
export function pendingCount(tasks: TaskView[], state: ReturnType<SyncStateStore["read"]>, target: string, windowHours?: number): number {
  return planSync(tasks, state, { target, ...(windowHours !== undefined ? { windowHours } : {}) }).toSync.length;
}

/** `/kankaku sync status`: the persisted state plus a locally-computed pending count. No network. */
export function computeSyncStatus(
  log: WorkLog,
  stateStore: SyncStateStore,
  target: string,
  windowHours?: number,
): { state: ReturnType<SyncStateStore["read"]>; pending: number } {
  const state = stateStore.read();
  const tasks = buildTasks(log.readAll());
  return { state, pending: pendingCount(tasks, state, target, windowHours) };
}

/**
 * Wrap an async function so concurrent callers share one in-flight call
 * instead of starting a new one each — kankaku's single-flight guard for
 * sync: `/kankaku sync`, the `session_start` auto-sync and the
 * `agent_settled` auto-sync all go through the same wrapped function, so
 * only one sync is ever running at a time within this process. (The
 * cross-process case is covered separately by `SyncStateStore`'s lock
 * file.) A caller that arrives while one is in flight joins its result
 * rather than queuing a fresh run — the next trigger (the next
 * `session_start` or `agent_settled`) will pick up anything missed, since
 * every sync also revisits the trailing window.
 */
export function singleFlight<Args extends unknown[], T>(fn: (...args: Args) => Promise<T>): (...args: Args) => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return (...args: Args): Promise<T> => {
    if (!inFlight) {
      inFlight = fn(...args).finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}
