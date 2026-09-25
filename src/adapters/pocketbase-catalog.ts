import type { Client, HubTask, Project } from "../domain/work-target.ts";
import type { PocketBaseClient, PocketBaseRecord } from "./pocketbase-client.ts";

interface ClientRecord extends PocketBaseRecord {
  name: string;
  code: string;
  active?: boolean;
  unassigned?: boolean;
}

interface ProjectRecord extends PocketBaseRecord {
  name: string;
  code?: string;
  client: string;
  repo_paths?: unknown;
  active?: boolean;
}

interface TaskRecord extends PocketBaseRecord {
  title?: string;
  project: string;
  status?: string;
  external_ref?: string;
}

const TASK_STATUSES = new Set(["open", "doing", "done"]);

function mapClient(record: ClientRecord): Client {
  return {
    id: record.id,
    name: record.name,
    code: record.code,
    active: record.active === true,
    ...(record.unassigned === true ? { unassigned: true } : {}),
  };
}

function mapProject(record: ProjectRecord): Project {
  return {
    id: record.id,
    name: record.name,
    ...(record.code !== undefined ? { code: record.code } : {}),
    clientId: record.client,
    repoPaths: Array.isArray(record.repo_paths) ? record.repo_paths.filter((path): path is string => typeof path === "string") : [],
    active: record.active === true,
  };
}

/** `open` on any unrecognised or missing status, rather than dropping the task. */
function mapTaskStatus(status: string | undefined): HubTask["status"] {
  return status !== undefined && TASK_STATUSES.has(status) ? (status as HubTask["status"]) : "open";
}

function mapTask(record: TaskRecord): HubTask {
  return {
    id: record.id,
    title: record.title ?? "",
    projectId: record.project,
    status: mapTaskStatus(record.status),
    ...(typeof record.external_ref === "string" && record.external_ref !== "" ? { externalRef: record.external_ref } : {}),
  };
}

/**
 * Build the `fetchCatalog` function {@link CachedCatalog} (`cached-catalog.ts`)
 * needs, backed by a {@link PocketBaseClient}. Fetches every `clients`,
 * `projects` and `tasks` record in parallel (no `active`/`status` filter,
 * so the domain resolver can tell "deleted" from "inactive"/"done"; see
 * `domain/work-target.ts`), clients/projects sorted by name and tasks by
 * title. `signal`, when given, bounds every fetch (see
 * `pocketbase-client.ts#request`).
 */
export function createPocketBaseCatalogFetcher(
  client: PocketBaseClient,
): (signal?: AbortSignal) => Promise<{ clients: Client[]; projects: Project[]; tasks: HubTask[] }> {
  return async (signal?: AbortSignal) => {
    const [clientRecords, projectRecords, taskRecords] = await Promise.all([
      client.list<ClientRecord>("clients", { sort: "name" }, signal),
      client.list<ProjectRecord>("projects", { sort: "name" }, signal),
      client.list<TaskRecord>("tasks", { sort: "title" }, signal),
    ]);

    return {
      clients: clientRecords.map(mapClient),
      projects: projectRecords.map(mapProject),
      tasks: taskRecords.map(mapTask),
    };
  };
}
