import type { TaskView } from "../domain/task-view.ts";

/** Which client a successfully pushed task ended up linked to, for the sync summary's `unassigned` grouping. See `domain/hub-entry.ts#resolveTaskAssignment`. */
export interface PushAssignment {
  /** `true` when the task was routed to the catalog's unassigned ("Sin determinar") client. */
  unassigned: boolean;
  /** The task's historical free-text/denormalised client label, only meaningful when `unassigned` is `true`. */
  legacyLabel?: string;
}

/** Outcome of pushing one task's `task_entries` row (and, if enabled, its `work_records` children). */
export type PushOutcome =
  | ({ kind: "created" } & PushAssignment)
  | ({ kind: "updated" } & PushAssignment)
  /** A non-retryable rejection (e.g. a real validation error) — recorded and skipped, not retried automatically. */
  | { kind: "failed"; reason: string }
  /** A network/timeout/5xx/auth failure. The caller must stop processing further tasks and not advance past this point. */
  | { kind: "error"; reason: string };

export interface PushTaskResult {
  taskId: string;
  outcome: PushOutcome;
}

/**
 * Uploads consolidated task rows to the hub. `push` is given tasks already
 * sorted chronologically by the caller and returns one result per task
 * attempted, in the same order — stopping (returning fewer results than
 * tasks given) at the first `"error"` outcome, since that signals a
 * systemic failure (network/timeout/5xx/auth) rather than a per-task one.
 * Never throws.
 */
export interface WorkSink {
  push(tasks: TaskView[]): Promise<PushTaskResult[]>;
}
