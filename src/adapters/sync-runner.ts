/**
 * Orchestrates one sync run: read every record, build tasks (never
 * re-implementing the aggregation — `buildTasks` is the only place it
 * lives), plan what needs pushing, push it, and persist the new state.
 * Never throws to its caller: every failure mode is folded into the
 * returned {@link SyncSummary}.
 */

import { buildTasks } from "../domain/task-view.ts";
import { computeTaskContentHash, planSync, pruneHashes } from "../domain/sync-plan.ts";
import type { SyncState } from "../domain/sync-plan.ts";
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

/**
 * Which automatic trigger asked for this run, or `undefined` for a manual
 * one (`/kankaku sync`, `sync all`, `backfill`) — see `runSync`'s
 * short-circuit and throttle, which apply only to the automatic path.
 * `session_shutdown` (pi awaits this handler — see `adapters/pi-tracker.ts`)
 * is, like `session_start`, never throttled: only `agent_settled` is.
 */
export type SyncTrigger = "session_start" | "agent_settled" | "session_shutdown";

export interface SyncRunnerDeps {
  log: WorkLog;
  sink: WorkSink;
  stateStore: SyncStateStore;
  clock: Clock;
  /** The configured hub URL — a state file synced against a different one triggers a full sync. */
  target: string;
  windowHours?: number;
  /**
   * `KANKAKU_SYNC_MIN_INTERVAL_MINUTES`, already converted to ms. Only
   * applies to the automatic path (`options.trigger` set). Defaults to 5
   * minutes; `0` disables throttling.
   */
  minAutoIntervalMs?: number;
}

const NO_LABEL = "(no label)";
const DEFAULT_MIN_AUTO_INTERVAL_MS = 5 * 60 * 1000;

/** The later of two ISO timestamps, treating `undefined` as earlier than anything. */
function laterIso(a: string | undefined, b: string): string {
  if (a === undefined) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function emptySummary(durationMs: number, syncedThrough: string | undefined): SyncSummary {
  return { uploaded: 0, updated: 0, skipped: 0, failed: [], unassigned: {}, syncedThrough, durationMs };
}

/**
 * Whether the automatic path's throttle should block this run right now.
 * Only `agent_settled` — fired once per prompt, far more often than a
 * session starts or ends — is ever throttled; `session_start` and
 * `session_shutdown` always bypass it (a session boundary is a good time
 * to catch up regardless of how recently the last automatic run happened,
 * and the shutdown one is awaited and time-bounded on its own — see
 * `adapters/pi-tracker.ts`). `undefined`/non-finite `lastRunAt` (never
 * run, or a malformed on-disk value) never throttles either — there is
 * nothing to measure the interval against.
 */
function isThrottled(state: SyncState | undefined, trigger: SyncTrigger, now: number, minIntervalMs: number): boolean {
  if (trigger !== "agent_settled") return false;
  if (minIntervalMs <= 0) return false;
  const lastRunAt = state?.lastRunAt;
  if (!Number.isFinite(lastRunAt)) return false;
  if (now - (lastRunAt as number) >= minIntervalMs) return false;
  return true;
}

/**
 * Run one sync pass. Acquires the cross-process lock for the whole run
 * (never held across `await` boundaries outside this function) so two pi
 * processes never race on the same `sync-state.json`.
 *
 * When `options.trigger` is set (the automatic `session_start`/
 * `agent_settled`/`session_shutdown` path, as opposed to a manual
 * `/kankaku sync`), two cheap gates run before any `WorkLog.readAll()` or
 * network call: (a) if the log's `version()` is unchanged since the last
 * successful sync and that sync did not error, skip entirely, for every
 * trigger; otherwise (b) throttle to at most one real attempt per
 * `minAutoIntervalMs`, but only for `agent_settled` — fired once per
 * prompt, so `version()` almost always differs right after it appended a
 * record. `session_start` and `session_shutdown` never throttle (see
 * `isThrottled`). Neither gate ever applies to a manual sync.
 */
export async function runSync(deps: SyncRunnerDeps, options: { full?: boolean; trigger?: SyncTrigger } = {}): Promise<SyncSummary> {
  const startedAt = deps.clock.now();

  if (options.trigger !== undefined) {
    const peek = deps.stateStore.read();
    const currentVersion = deps.log.version?.();
    const versionUnchanged = currentVersion !== undefined && peek?.logVersion === currentVersion;
    if (versionUnchanged && peek?.lastError === undefined) {
      return emptySummary(deps.clock.now() - startedAt, peek?.syncedThrough);
    }

    const minIntervalMs = deps.minAutoIntervalMs ?? DEFAULT_MIN_AUTO_INTERVAL_MS;
    if (isThrottled(peek, options.trigger, deps.clock.now(), minIntervalMs)) {
      return emptySummary(deps.clock.now() - startedAt, peek?.syncedThrough);
    }
  }

  let lockAcquired = false;
  try {
    lockAcquired = deps.stateStore.tryLock();
    if (!lockAcquired) {
      const state = deps.stateStore.read();
      return { ...emptySummary(deps.clock.now() - startedAt, state?.syncedThrough), locked: true };
    }

    const state = deps.stateStore.read();
    // Captured once, here, and persisted as-is below: this is the version
    // the tasks below were actually built from, not whatever the log might
    // become by the time an awaited push finishes.
    const logVersionAtRead = deps.log.version?.();
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
      persistError(deps, state, message, logVersionAtRead);
      return summary;
    }

    const byId = new Map(plan.toSync.map((task) => [task.id, task]));
    // Both are keyed by content that ultimately traces back to free-text
    // worklog/legacy-client data (task ids, legacy client labels): built in
    // a `Map` and emitted via `Object.fromEntries` below (never
    // `newHashes[task.id] = ...` on a plain object), so a value like
    // `__proto__` or `constructor` becomes a normal own entry instead of
    // silently colliding with an inherited `Object.prototype` property.
    const newHashes = new Map<string, string>();
    const failed: Array<{ id: string; reason: string }> = [];
    const unassigned = new Map<string, number>();
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
        newHashes.set(task.id, computeTaskContentHash(task));
        syncedThrough = laterIso(syncedThrough, task.endedAt);
        progressed = true;
        if (result.outcome.unassigned) {
          const label = result.outcome.legacyLabel || NO_LABEL;
          unassigned.set(label, (unassigned.get(label) ?? 0) + 1);
        }
      } else if (result.outcome.kind === "failed") {
        // Recorded and skipped, not retried forever: stamp its hash too so
        // an unchanged, permanently-invalid task is not resent every run.
        failed.push({ id: task.id, reason: result.outcome.reason });
        newHashes.set(task.id, computeTaskContentHash(task));
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

    const mergedHashes = { ...(state?.hashes ?? {}), ...Object.fromEntries(newHashes) };
    // G2: no longer window-bound — see `domain/sync-plan.ts#pruneHashes`'s
    // doc comment. `tasks` here is every task `buildTasks` currently knows
    // about (the full `readAll()`, not just this run's eligible/window
    // subset), so a hash is only ever dropped for a task id that has
    // genuinely vanished, never merely because it is old.
    const prunedHashes = pruneHashes(mergedHashes, tasks);
    // Only adopt deps.target as the persisted target once this run has
    // actually resolved something against it; otherwise keep whatever
    // target (if any) the previous state was synced against.
    const persistedTarget = progressed || state === undefined ? deps.target : state.target;

    deps.stateStore.write({
      target: persistedTarget,
      ...(syncedThrough !== undefined ? { syncedThrough } : {}),
      hashes: prunedHashes,
      ...(stopError !== undefined ? { lastError: { message: stopError, at: new Date(deps.clock.now()).toISOString() } } : {}),
      ...(logVersionAtRead !== undefined ? { logVersion: logVersionAtRead } : {}),
      lastRunAt: deps.clock.now(),
    });

    return {
      uploaded,
      updated,
      skipped: plan.unchangedCount,
      failed,
      unassigned: Object.fromEntries(unassigned),
      syncedThrough,
      durationMs: deps.clock.now() - startedAt,
      ...(stopError !== undefined ? { error: stopError } : {}),
    };
  } finally {
    if (lockAcquired) deps.stateStore.unlock();
  }
}

function persistError(deps: SyncRunnerDeps, state: ReturnType<SyncStateStore["read"]>, message: string, logVersionAtRead: string | number | undefined): void {
  deps.stateStore.write({
    target: deps.target,
    ...(state?.syncedThrough !== undefined ? { syncedThrough: state.syncedThrough } : {}),
    hashes: state?.hashes ?? {},
    lastError: { message, at: new Date(deps.clock.now()).toISOString() },
    ...(logVersionAtRead !== undefined ? { logVersion: logVersionAtRead } : {}),
    lastRunAt: deps.clock.now(),
  });
}

/** Number of tasks pending a sync right now, for `/kankaku sync status` — computed locally, no network. */
export function pendingCount(tasks: TaskView[], state: ReturnType<SyncStateStore["read"]>, target: string, windowHours?: number): number {
  const plan = planSync(tasks, state, { target, ...(windowHours !== undefined ? { windowHours } : {}) });
  return plan.toSync.length + plan.correctionsDeferred;
}

/**
 * `/kankaku sync status`: the persisted state, a locally-computed pending
 * count, and (R3) how many tasks changed since their last sync but fall
 * outside this run's revisit window — a `sync all` needed to pick them up
 * (see `domain/sync-plan.ts#SyncPlan.staleOutsideWindow`, and README "Hub
 * (PocketBase)" > "Sync" > "Limitations"). No network.
 */
export function computeSyncStatus(
  log: WorkLog,
  stateStore: SyncStateStore,
  target: string,
  windowHours?: number,
): { state: ReturnType<SyncStateStore["read"]>; pending: number; staleOutsideWindow: number } {
  const state = stateStore.read();
  const tasks = buildTasks(log.readAll());
  const plan = planSync(tasks, state, { target, ...(windowHours !== undefined ? { windowHours } : {}) });
  // Deferred corrections are pending too: the cap only spreads them over runs.
  return { state, pending: plan.toSync.length + plan.correctionsDeferred, staleOutsideWindow: plan.staleOutsideWindow.length };
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
