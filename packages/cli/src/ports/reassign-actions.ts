import type { HubRowSnapshot, ReassignCatalog, ReassignPlan, RowOutcome } from "../domain/reassign-model.ts";

/** What the hub holds for the asked tasks, or why it could not be asked. */
export type ReassignPrepared = { ok: true; catalog: ReassignCatalog; rows: ReadonlyMap<string, HubRowSnapshot> } | { ok: false; message: string };

/**
 * The hub side of the Tasks screen's reassignment, injected into the UI so
 * a scripted fake can stand in for it in tests. Neither method throws: a
 * hub that cannot be reached, or that rejects the credentials, is reported
 * as a message (`prepare`) or as a per-row failure (`apply`).
 */
export interface ReassignActions {
  /** Read the hub rows of `taskIds` (by kankaku task id) and refresh the catalog, bounded in time. */
  prepare(taskIds: string[]): Promise<ReassignPrepared>;
  /** Send one PATCH per `reassign` line of `plan`; resolves one outcome per such line, in order, then refreshes the catalog. */
  apply(plan: ReassignPlan): Promise<RowOutcome[]>;
}
