/**
 * `/kankaku assign`'s hub side: read the most recent synced `task_entries`
 * rows for a selector, and PATCH one row's assignment by its `task_id`.
 *
 * The record lookup mirrors `pocketbase-sink.ts` (`findOne`): filter by the
 * unique `task_id`, then PATCH the record's PocketBase id. See README "Hub
 * (PocketBase)" > "Assignment is create-only" for why only the
 * `{ client, project }` pair is ever sent here — never `task`,
 * `legacy_client_label`, or any measurement field.
 */

import type { HubAssignPayload } from "../domain/hub-assign.ts";
import type { PocketBaseClient, PocketBaseListResult, PocketBaseRecord } from "./pocketbase-client.ts";
import { escapeFilterValue } from "./pocketbase-sink.ts";

/** One `task_entries` row, as far as the assign selector needs it. */
export interface SyncedTaskEntryRow {
  /** PocketBase record id. */
  id: string;
  taskId: string;
  prompt?: string;
  startedAt?: string;
  /** `clients` relation id, as stored on the row. */
  client?: string;
  /** `projects` relation id, as stored on the row. */
  project?: string;
}

/** Whether the PATCH found and moved a row. */
export type HubAssignOutcome = { kind: "assigned"; recordId: string } | { kind: "not-found" };

/** Read/assign access to the hub's `task_entries` rows. Present only when the hub is configured. */
export interface HubAssign {
  /** The `limit` most recently started `task_entries` rows, newest first. */
  listRecent(limit?: number): Promise<SyncedTaskEntryRow[]>;
  /** PATCH the exact `{ client, project }` pair onto the row whose `task_id` is `taskId`. */
  assign(taskId: string, payload: HubAssignPayload): Promise<HubAssignOutcome>;
}

export interface HubAssignDeps {
  client: PocketBaseClient;
  /** Rows returned by {@link HubAssign.listRecent} when no limit is given. Defaults to 20. */
  listLimit?: number;
}

const DEFAULT_LIST_LIMIT = 20;

const TASK_ENTRIES = "task_entries";
const TASK_ENTRIES_RECORDS = `/api/collections/${TASK_ENTRIES}/records`;

/** Non-empty string, or `undefined` (a PocketBase field can be absent or empty). */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Map a raw record to the selector's shape, dropping every field the assign flow must not show or send. */
function toRow(record: PocketBaseRecord & Record<string, unknown>): SyncedTaskEntryRow {
  const prompt = optionalString(record["prompt"]);
  const startedAt = optionalString(record["started_at"]);
  const client = optionalString(record["client"]);
  const project = optionalString(record["project"]);
  return {
    id: record.id,
    taskId: optionalString(record["task_id"]) ?? "",
    ...(prompt !== undefined ? { prompt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(client !== undefined ? { client } : {}),
    ...(project !== undefined ? { project } : {}),
  };
}

/**
 * Build a {@link HubAssign} over a {@link PocketBaseClient}.
 *
 * `listRecent` reads a single page (newest first by `started_at`) rather
 * than `PocketBaseClient.list`, which would paginate through every row just
 * to keep the first N. `assign` uses `client.list` exactly like
 * `pocketbase-sink.ts#findOne`, so a `task_id` with quotes or backslashes is
 * escaped the same way.
 */
export function createHubAssign(deps: HubAssignDeps): HubAssign {
  const limit = deps.listLimit ?? DEFAULT_LIST_LIMIT;

  return {
    async listRecent(rows = limit): Promise<SyncedTaskEntryRow[]> {
      const params = new URLSearchParams({ page: "1", perPage: String(rows), sort: "-started_at" });
      const result = await deps.client.request<PocketBaseListResult<PocketBaseRecord & Record<string, unknown>>>(
        "GET",
        `${TASK_ENTRIES_RECORDS}?${params.toString()}`,
      );
      return result.items.map(toRow);
    },

    async assign(taskId: string, payload: HubAssignPayload): Promise<HubAssignOutcome> {
      const items = await deps.client.list<PocketBaseRecord & Record<string, unknown>>(TASK_ENTRIES, {
        filter: `task_id="${escapeFilterValue(taskId)}"`,
        perPage: 1,
      });
      const record = items[0];
      if (!record) return { kind: "not-found" };

      // Exactly the pair — never `payload` by reference, so a future caller
      // cannot smuggle another field in through a widened object.
      await deps.client.request("PATCH", `${TASK_ENTRIES_RECORDS}/${record.id}`, {
        client: payload.client,
        project: payload.project,
      });
      return { kind: "assigned", recordId: record.id };
    },
  };
}
