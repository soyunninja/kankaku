/**
 * Decide which tasks a sync run should push, without touching the network
 * or the filesystem. Pure, no I/O — see `sync-runner.ts` for the adapter
 * that drives this with a real clock, `WorkLog` and `WorkSink`.
 *
 * A task is not final the moment it is first written: a background
 * subagent can settle after its orchestrator and extend the task's union
 * (see `task-view.ts`), which is exactly why every sync also revisits a
 * trailing window behind the watermark instead of only pushing brand-new
 * tasks (proposal §6.0).
 */

import { computeCostQuality, computeSubagentLinkage } from "./hub-entry.ts";
import type { TaskView } from "./task-view.ts";

/** Persisted sync state (`<KANKAKU_DIR>/sync-state.json`). */
export interface SyncState {
  /** High-watermark ISO timestamp: everything with `endedAt` at or before `syncedThrough - window` is considered done. `undefined` before the first successful sync. */
  syncedThrough?: string;
  /** Content hash per task id (see {@link computeTaskContentHash}), pruned to the revisit window so the file stays small. */
  hashes: Record<string, string>;
  /** The hub URL this state was synced against; a state written for a different URL is treated as absent (full sync). */
  target: string;
  /** Set after a network/5xx failure stopped a run short; cleared by the next fully-successful run. */
  lastError?: { message: string; at: string };
  /**
   * The `WorkLog`'s cheap change signal (`version()`) as of the last real
   * (non-short-circuited) automatic-or-manual sync attempt. The automatic
   * path (`session_start`/`agent_settled`) compares this against the
   * current value to skip entirely — no `readAll()`, no network — when
   * nothing has changed and the last attempt did not error. See
   * `adapters/sync-runner.ts#runSync`.
   */
  logVersion?: string | number;
  /**
   * `Clock`-based timestamp (ms) of the last real (non-short-circuited)
   * automatic sync attempt, persisted so the automatic path's throttle
   * (`KANKAKU_SYNC_MIN_INTERVAL_MINUTES`) holds across processes, not just
   * within one. Never touched by a manual sync.
   */
  lastRunAt?: number;
}

export interface SyncPlanOptions {
  /** The configured hub URL. A state whose `target` differs triggers a full sync. */
  target: string;
  /** Revisit window in hours, applied behind `syncedThrough`. Defaults to 24. */
  windowHours?: number;
  /** Force every task to be (re-)evaluated, e.g. `/kankaku sync all`. */
  full?: boolean;
}

export interface SyncPlan {
  /** Tasks whose content changed (or were never synced) and therefore need a request, in chronological (`endedAt`) order. */
  toSync: TaskView[];
  /** How many eligible tasks were skipped because their stored hash already matched — no request needed for them. */
  unchangedCount: number;
  /** `true` when this run evaluated every task rather than only the revisit window. */
  isFullSync: boolean;
  /**
   * Tasks outside this run's revisit window that were NEVER synced to this
   * hub: an ordinary incremental sync does not look that far back for new
   * work, so only `sync all` (or `backfill`) uploads them. A task the hub
   * already holds never appears here — if it changed it is in `toSync`.
   * Always empty for a full sync. Surfaced by `/kankaku sync status`.
   */
  staleOutsideWindow: TaskView[];
  /** Already-synced rows that changed but were left for a later run by {@link MAX_CORRECTIONS_PER_RUN}. */
  correctionsDeferred: number;
}

const DEFAULT_WINDOW_HOURS = 24;

/** How many already-synced, out-of-window rows one incremental run corrects at most; the rest wait for the next run (or `sync all`). */
export const MAX_CORRECTIONS_PER_RUN = 50;

function windowMs(hours: number): number {
  return hours * 60 * 60 * 1000;
}

/** Stable (key-sorted) JSON serialization so field order never changes a hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** FNV-1a 32-bit over a UTF-16 code-unit stream — not a security hash, just a cheap deterministic change fingerprint. */
function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Content hash of everything a re-sync could change: the measurement
 * fields (never the assignment — a reassignment made in the web is never
 * visible locally, and must never trigger a resync on its own). A task
 * whose hash matches the last stored one is unchanged and can be skipped
 * without a request. Includes the derived measurement-quality fields
 * (`domain/hub-entry.ts`) too, not just the raw numbers they are computed
 * from: a background subagent that joins *after* this task was first
 * synced can turn `cost_quality`/`subagent_linkage` from `"unknown"`/
 * `"unlinked"` into a better answer without any of the other numeric
 * fields necessarily changing (e.g. a joined child with no cost of its own
 * still flips `subagent_linkage`) — that must still trigger a resync.
 * `waiting_quality` is a true constant (`domain/hub-entry.ts`'s
 * `computeWaitingQuality`) and is deliberately left out: it can never
 * change between two evaluations of the same task. `sessionDir` is also a
 * measurement-style field (`domain/hub-entry.ts`'s `session_dir`, sent on
 * both create and update) — its own change, e.g. a resume that switches to
 * a non-default session directory, must trigger a resync on its own even
 * when nothing else changed.
 */
export function computeTaskContentHash(task: TaskView): string {
  return fingerprint(
    stableStringify({
      endedAt: task.endedAt,
      status: task.status,
      wallMs: task.wallMs,
      waitingMs: task.waitingMs,
      workMs: task.workMs,
      subagentCount: task.subagents.length,
      usage: task.usage,
      segments: task.segments,
      costQuality: computeCostQuality(task),
      subagentLinkage: computeSubagentLinkage(task),
      sessionDir: task.sessionDir,
      // `undefined` is dropped by the serialiser, so a task that never knew
      // its reasoning effort keeps the hash it had before this field existed.
      thinkingLevel: task.orchestrator.thinkingLevel,
    }),
  );
}

/**
 * Decide which tasks need a request this run.
 *
 * Eligibility: every task, when there is no state yet, the state's
 * `target` differs from the configured hub URL, or `options.full` is set
 * (a full sync); otherwise only tasks with `endedAt` after
 * `syncedThrough - window`. Within the eligible set, a task is only
 * included in `toSync` when its current content hash differs from the one
 * stored in `state.hashes` (absent, i.e. never synced, always counts as
 * different).
 */
export function planSync(tasks: TaskView[], state: SyncState | undefined, options: SyncPlanOptions): SyncPlan {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const isFullSync = options.full === true || state === undefined || state.target !== options.target;

  const sorted = [...tasks].sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));

  let eligible: TaskView[];
  let outsideWindow: TaskView[];
  if (isFullSync) {
    eligible = sorted;
    outsideWindow = [];
  } else {
    const syncedThroughMs = state.syncedThrough ? Date.parse(state.syncedThrough) : Number.NEGATIVE_INFINITY;
    const cutoff = syncedThroughMs - windowMs(windowHours);
    eligible = sorted.filter((task) => Date.parse(task.endedAt) > cutoff);
    outsideWindow = sorted.filter((task) => Date.parse(task.endedAt) <= cutoff);
  }

  const hashes = state?.hashes ?? {};
  const changed = (task: TaskView): boolean => hashes[task.id] !== computeTaskContentHash(task);
  // A row the hub ALREADY holds is corrected wherever it sits: the window
  // bounds how far back NEW work is looked for, never whether a known row
  // may go stale. A child can move between tasks (task-view.ts's rescue
  // join, or a crash-recovered parent appearing later), so a task can
  // SHRINK — skipping it would leave its old, larger cost on the hub next
  // to the row the money moved to.
  // Newest first and capped: anything that invalidates many stored hashes at
  // once (a new field in the content hash, a damaged state file) must drain
  // over several runs, never as one burst from an automatic sync. New work
  // goes FIRST and corrections last, so a correction the hub keeps failing
  // (the runner stops at the first transport error) can never hold newer
  // rows back; the runner's watermark is a max, so the order is safe for it.
  const allCorrections = outsideWindow.filter((task) => hashes[task.id] !== undefined && changed(task)).reverse();
  const knownAndChanged = isFullSync ? allCorrections : allCorrections.slice(0, MAX_CORRECTIONS_PER_RUN);
  const correctionsDeferred = allCorrections.length - knownAndChanged.length;
  const toSync = [...eligible.filter(changed), ...knownAndChanged];
  // R3: cheap, pure visibility into a task that changed but that this
  // incremental run's window will not re-evaluate — see SyncPlan's doc
  // comment. No extra work: `outsideWindow` is already computed above,
  // this just re-applies the same hash-mismatch check to it.
  const staleOutsideWindow = outsideWindow.filter((task) => hashes[task.id] === undefined);

  return { toSync, unchangedCount: eligible.length - eligible.filter(changed).length, isFullSync, staleOutsideWindow, correctionsDeferred };
}

/**
 * Drop hash entries for task ids that no longer exist in `tasks` (which
 * should not normally happen since `worklog.jsonl` is append-only — this
 * is a defensive backstop, not the normal path). `sync-state.json`'s
 * `hashes` are otherwise kept **forever** for every task this process
 * still knows about, regardless of how far outside the revisit window its
 * `endedAt` has fallen (G2 fix).
 *
 * This used to also drop a hash once its task's `endedAt` fell behind
 * `syncedThrough - window` — but `planSync`'s `staleOutsideWindow` treats a
 * *missing* hash exactly like "content changed" (there is no third state
 * for "unchanged but I forgot"), so that window-based pruning made every
 * task older than the window look permanently changed, forever, the moment
 * its hash was first pruned: `/kankaku sync status` would report a
 * never-shrinking "changed outside the window" count that training taught
 * users to ignore (the bug this rewrite fixes).
 *
 * Never pruning by window instead means `hashes` grows with the total
 * number of distinct tasks a directory has ever synced, not with time — an
 * FNV-1a hash is 8 hex chars and a task id (a `crypto.randomUUID()`) is 36,
 * so each retained entry costs roughly 50 bytes of JSON. Measured: 10,000
 * entries serialize to well under 1MB (see `tests/sync-plan.test.ts`'s
 * state-size-bound test) — even a directory with a decade of daily,
 * multi-task-per-day history stays a small, instantly-parseable file. A
 * coarser design (e.g. one rolling digest per closed day) would bound the
 * file even tighter, but cannot answer "which specific task changed" —
 * `staleOutsideWindow` needs exactly that, per-task precision, to stay
 * useful — so it was rejected in favour of this simpler, still-cheap
 * per-task scheme.
 *
 * No migration is needed for an existing `sync-state.json`: it already has
 * exactly this shape (`Record<taskId, hash>`), just with some outside-
 * window entries already missing from a build that pruned them. The first
 * sync after upgrading treats each of those exactly like "never synced" —
 * a real fact this process cannot know is false, since the old hash is
 * genuinely gone — and reports it once via `staleOutsideWindow`; once that
 * task's hash is recorded again (an ordinary `sync all`, or simply being
 * observed unchanged), this function never drops it again. See
 * `tests/sync-plan.test.ts`'s "first sync after upgrading" test.
 *
 * Accumulated in a `Map` and emitted via `Object.fromEntries` (never
 * `pruned[id] = ...` on a plain object), since a task id ultimately traces
 * back to free-text worklog content: a value like `__proto__` written to a
 * plain object would silently no-op (the inherited accessor ignores a
 * non-object assignment) instead of being kept as an own property.
 */
export function pruneHashes(hashes: Record<string, string>, tasks: TaskView[]): Record<string, string> {
  const knownIds = new Set(tasks.map((task) => task.id));

  const pruned = new Map<string, string>();
  for (const [id, hash] of Object.entries(hashes)) {
    if (knownIds.has(id)) pruned.set(id, hash);
  }
  return Object.fromEntries(pruned);
}
