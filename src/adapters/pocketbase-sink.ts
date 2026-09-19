/**
 * {@link WorkSink} backed by a real PocketBase instance: upserts one
 * `task_entries` row per task (create-only assignment, see
 * `domain/hub-entry.ts`) and, when enabled, its `work_records` children.
 *
 * PocketBase has no native upsert (contract.md "Upsert by task_id"): look
 * up existing rows by their unique key in chunks, then create or patch.
 * A unique-violation on create (approximated here as any 400 on create,
 * since `PocketBaseError` does not carry the response body — see the
 * `isLikelyUniqueViolation` note below) is treated as "already exists":
 * look it up and patch instead.
 */

import { buildTaskEntryCreatePayload, buildTaskEntryUpdatePayload, buildWorkRecordPayload, resolveTaskAssignment, taskWorkRecords } from "../domain/hub-entry.ts";
import type { PromptPrivacyMode } from "../domain/hub-entry.ts";
import type { TaskView } from "../domain/task-view.ts";
import type { Client, Project } from "../domain/work-target.ts";
import type { PushOutcome, PushTaskResult, WorkSink } from "../ports/work-sink.ts";
import type { PocketBaseClient, PocketBaseRecord } from "./pocketbase-client.ts";
import { PocketBaseError } from "./pocketbase-client.ts";

export interface PocketBaseSinkDeps {
  client: PocketBaseClient;
  /** Catalog snapshot to resolve assignment against; see `domain/hub-entry.ts#resolveTaskAssignment`. */
  clients: Client[];
  projects: Project[];
  machine: string;
  promptMode: PromptPrivacyMode;
  /** `KANKAKU_SYNC_RECORDS` (default enabled): also upsert each task's raw `work_records`. */
  syncRecords: boolean;
  /** ids per lookup request. Defaults to 30, per contract.md's guidance. */
  chunkSize?: number;
}

const DEFAULT_CHUNK_SIZE = 30;

/** Escape a value for PocketBase's filter string-literal syntax (`field="value"`). */
function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Fatal (systemic) errors stop the whole sync run rather than failing one task. */
function isFatalError(error: unknown): boolean {
  if (!(error instanceof PocketBaseError)) return true;
  if (error.kind === "network" || error.kind === "timeout" || error.kind === "auth") return true;
  if (error.kind === "http" && error.status !== undefined && error.status >= 500) return true;
  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `PocketBaseError` for a create only carries `status`/`kind`, not the
 * parsed response body, so we cannot check `data.<field>.code ===
 * "validation_not_unique"` directly (contract.md "What a unique-violation
 * response actually looks like"). Instead, any 400 on a create is treated
 * as a possible race and re-looked-up: if the row now exists, it was a
 * duplicate (patch it); if not, it was a genuine validation error (the
 * original message is kept).
 */
function isLikelyUniqueViolation(error: unknown): boolean {
  return error instanceof PocketBaseError && error.kind === "http" && error.status === 400;
}

export class PocketBaseSink implements WorkSink {
  private readonly deps: PocketBaseSinkDeps;

  constructor(deps: PocketBaseSinkDeps) {
    this.deps = deps;
  }

  private get chunkSize(): number {
    return this.deps.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  /** Look up existing records by a unique field, chunked to ~30 ids per request; returns a map of that field's value to the record's PocketBase id. */
  private async lookupExisting(collection: string, field: string, values: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const chunkSize = this.chunkSize;

    for (let i = 0; i < values.length; i += chunkSize) {
      const chunk = values.slice(i, i + chunkSize);
      if (chunk.length === 0) continue;
      const filter = chunk.map((value) => `${field}="${escapeFilterValue(value)}"`).join("||");
      const items = await this.deps.client.list<PocketBaseRecord & Record<string, unknown>>(collection, { filter, perPage: chunkSize });
      for (const item of items) {
        const value = item[field];
        if (typeof value === "string") found.set(value, item.id);
      }
    }

    return found;
  }

  private async findOne(collection: string, field: string, value: string): Promise<string | undefined> {
    const found = await this.lookupExisting(collection, field, [value]);
    return found.get(value);
  }

  /** Create-or-patch one task_entries row. Returns its PocketBase record id and whether it was created or updated. */
  private async upsertTaskEntry(task: TaskView, existingId: string | undefined): Promise<{ id: string; created: boolean }> {
    const ctx = { clients: this.deps.clients, projects: this.deps.projects, machine: this.deps.machine, promptMode: this.deps.promptMode };

    if (existingId) {
      await this.deps.client.request("PATCH", `/api/collections/task_entries/records/${existingId}`, buildTaskEntryUpdatePayload(task, ctx));
      return { id: existingId, created: false };
    }

    try {
      const created = await this.deps.client.request<PocketBaseRecord>(
        "POST",
        "/api/collections/task_entries/records",
        buildTaskEntryCreatePayload(task, ctx),
      );
      return { id: created.id, created: true };
    } catch (error) {
      if (!isLikelyUniqueViolation(error)) throw error;
      const found = await this.findOne("task_entries", "task_id", task.id);
      if (!found) throw error;
      await this.deps.client.request("PATCH", `/api/collections/task_entries/records/${found}`, buildTaskEntryUpdatePayload(task, ctx));
      return { id: found, created: false };
    }
  }

  /** Best-effort upsert of one task's work_records children. A per-record validation failure is swallowed (the task_entries row already succeeded); a fatal error propagates so the whole run stops. */
  private async upsertWorkRecords(task: TaskView, taskEntryRecordId: string): Promise<void> {
    const records = taskWorkRecords(task);
    const existing = await this.lookupExisting(
      "work_records",
      "kankaku_id",
      records.map((record) => record.id),
    );

    for (const record of records) {
      const payload = buildWorkRecordPayload(record, taskEntryRecordId, { machine: this.deps.machine, promptMode: this.deps.promptMode });
      const existingId = existing.get(record.id);
      try {
        if (existingId) {
          await this.deps.client.request("PATCH", `/api/collections/work_records/records/${existingId}`, payload);
        } else {
          try {
            await this.deps.client.request("POST", "/api/collections/work_records/records", payload);
          } catch (error) {
            if (!isLikelyUniqueViolation(error)) throw error;
            const found = await this.findOne("work_records", "kankaku_id", record.id);
            if (!found) throw error;
            await this.deps.client.request("PATCH", `/api/collections/work_records/records/${found}`, payload);
          }
        }
      } catch (error) {
        if (isFatalError(error)) throw error;
        // Non-fatal: this one child row failed validation; the task_entries
        // row it belongs to already succeeded, so skip it and keep going.
      }
    }
  }

  private async pushOne(task: TaskView, existingId: string | undefined): Promise<PushOutcome> {
    const assignment = resolveTaskAssignment(task, this.deps.clients, this.deps.projects);
    const pushAssignment = { unassigned: assignment.routedToUnassigned, ...(assignment.legacyClientLabel ? { legacyLabel: assignment.legacyClientLabel } : {}) };

    try {
      const { id, created } = await this.upsertTaskEntry(task, existingId);

      if (this.deps.syncRecords) {
        await this.upsertWorkRecords(task, id);
      }

      return created ? { kind: "created", ...pushAssignment } : { kind: "updated", ...pushAssignment };
    } catch (error) {
      if (isFatalError(error)) return { kind: "error", reason: describeError(error) };
      return { kind: "failed", reason: describeError(error) };
    }
  }

  async push(tasks: TaskView[]): Promise<PushTaskResult[]> {
    const results: PushTaskResult[] = [];
    if (tasks.length === 0) return results;

    // One chunked lookup for every task up front (contract.md: "one list
    // request per ~30 ids"), rather than one lookup per task.
    let existingByTaskId: Map<string, string>;
    try {
      existingByTaskId = await this.lookupExisting(
        "task_entries",
        "task_id",
        tasks.map((task) => task.id),
      );
    } catch (error) {
      const outcome: PushOutcome = isFatalError(error) ? { kind: "error", reason: describeError(error) } : { kind: "failed", reason: describeError(error) };
      results.push({ taskId: tasks[0]!.id, outcome });
      return results;
    }

    for (const task of tasks) {
      const outcome = await this.pushOne(task, existingByTaskId.get(task.id));
      results.push({ taskId: task.id, outcome });
      if (outcome.kind === "error") break;
    }

    return results;
  }
}
