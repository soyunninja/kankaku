/**
 * The hub side of the Tasks screen's reassignment: read the `task_entries`
 * rows of some kankaku tasks (by `task_id`, in chunks) and PATCH their
 * `client`/`project`/`task` relations, both through the published
 * `kankaku-pi/hub` client, so authentication, the 401 re-auth and the
 * per-request time bound are the client's own. Sync stays create-only:
 * this is the only path that changes an existing row's assignment, and it
 * sends nothing but those three relations (never `legacy_client_label`,
 * never a measurement field).
 */
import { PocketBaseClient, PocketBaseError, escapeFilterValue } from "kankaku-pi/hub";
import type { HubCredentials, PocketBaseRecord } from "kankaku-pi/hub";
import { createCatalog } from "./hub.ts";
import type { CreateCatalogDeps } from "./hub.ts";
import type { HubRowSnapshot, ReassignPlan, RowOutcome } from "../domain/reassign-model.ts";
import type { ReassignActions, ReassignPrepared } from "../ports/reassign-actions.ts";

/** Task ids per lookup request, per the hub contract's guidance (and the sync sink's own chunking). */
const LOOKUP_CHUNK_SIZE = 30;
/** Overall bound for `prepare` (row lookups plus the catalog refresh), on top of each request's own time bound. */
const PREPARE_TIMEOUT_MS = 20_000;

function relation(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The hub rows of `taskIds`, keyed by kankaku task id. A task with no row
 * is simply absent from the map. An empty relation reads `""`. A hub
 * failure propagates as the client's `PocketBaseError`.
 */
export async function fetchHubRows(
  client: PocketBaseClient,
  taskIds: string[],
  options: { chunkSize?: number; signal?: AbortSignal } = {},
): Promise<Map<string, HubRowSnapshot>> {
  const chunkSize = options.chunkSize ?? LOOKUP_CHUNK_SIZE;
  const rows = new Map<string, HubRowSnapshot>();

  for (let start = 0; start < taskIds.length; start += chunkSize) {
    const chunk = taskIds.slice(start, start + chunkSize);
    const filter = chunk.map((taskId) => `task_id="${escapeFilterValue(taskId)}"`).join("||");
    const items = await client.list<PocketBaseRecord>("task_entries", { filter, perPage: chunkSize }, options.signal);
    for (const item of items) {
      const taskId = item["task_id"];
      if (typeof taskId !== "string") continue;
      rows.set(taskId, {
        rowId: item.id,
        taskId,
        clientId: relation(item["client"]),
        projectId: relation(item["project"]),
        hubTaskId: relation(item["task"]),
      });
    }
  }

  return rows;
}

/** A short, plain reason for a failed hub call: never a URL, a row id or a stack. */
export function describeHubError(error: unknown): string {
  if (!(error instanceof PocketBaseError)) return error instanceof Error ? error.message : String(error);
  switch (error.kind) {
    case "auth":
      return "the hub rejected the credentials";
    case "timeout":
      return "the request timed out";
    case "network":
      return "the hub is unreachable";
    case "http":
      if (error.status === 400) return "the hub rejected the change (400)";
      if (error.status === 403) return "not allowed to change this row (403)";
      if (error.status === 404) return "the row no longer exists on the hub (404)";
      return `the hub answered ${error.status ?? "an error"}`;
  }
}

/**
 * One `PATCH /api/collections/task_entries/records/<rowId>` per `reassign`
 * line, body `{ client, project, task }` (`""` for an empty relation).
 * Rows are sent one after the other; a failure is recorded for its row and
 * the rest still run. Returns one outcome per `reassign` line, in order.
 */
export async function applyReassignment(client: PocketBaseClient, plan: ReassignPlan): Promise<RowOutcome[]> {
  const outcomes: RowOutcome[] = [];
  for (const line of plan.lines) {
    if (line.kind !== "reassign") continue;
    const body = { client: line.payload.client, project: line.payload.project, task: line.payload.task };
    try {
      await client.request("PATCH", `/api/collections/task_entries/records/${encodeURIComponent(line.rowId)}`, body);
      outcomes.push({ taskId: line.taskId, status: "reassigned" });
    } catch (error) {
      outcomes.push({ taskId: line.taskId, status: "failed", reason: describeHubError(error) });
    }
  }
  return outcomes;
}

/** Build the {@link ReassignActions} for `credentials`: one client for the row lookups and the PATCHes, the disk-backed catalog for the refresh. */
export function createReassignActions(credentials: HubCredentials, deps: CreateCatalogDeps): ReassignActions {
  const client = new PocketBaseClient({ ...credentials, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const catalog = createCatalog(credentials, deps);

  return {
    async prepare(taskIds): Promise<ReassignPrepared> {
      const signal = AbortSignal.timeout(PREPARE_TIMEOUT_MS);
      try {
        const rows = await fetchHubRows(client, taskIds, { signal });
        const snapshot = await catalog.refresh(signal);
        if (snapshot === undefined) return { ok: false, message: "could not refresh the catalog from the hub" };
        return { ok: true, rows, catalog: { clients: snapshot.clients, projects: snapshot.projects, tasks: snapshot.tasks ?? [] } };
      } catch (error) {
        return { ok: false, message: describeHubError(error) };
      }
    },

    async apply(plan): Promise<RowOutcome[]> {
      const outcomes = await applyReassignment(client, plan);
      // Task statuses may have moved (opening a task marks it as doing); a failed refresh only leaves the cache as it was.
      await catalog.refresh().catch(() => undefined);
      return outcomes;
    },
  };
}
