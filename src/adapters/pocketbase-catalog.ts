import type { Client, Project } from "../domain/work-target.ts";
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

/**
 * Build the `fetchCatalog` function {@link CachedCatalog} (`cached-catalog.ts`)
 * needs, backed by a {@link PocketBaseClient}. Fetches every `clients` and
 * `projects` record (no `active` filter, so the domain resolver can tell
 * "deleted" from "inactive"; see `domain/work-target.ts`), sorted by name.
 */
export function createPocketBaseCatalogFetcher(client: PocketBaseClient): () => Promise<{ clients: Client[]; projects: Project[] }> {
  return async () => {
    const [clientRecords, projectRecords] = await Promise.all([
      client.list<ClientRecord>("clients", { sort: "name" }),
      client.list<ProjectRecord>("projects", { sort: "name" }),
    ]);

    return {
      clients: clientRecords.map(mapClient),
      projects: projectRecords.map(mapProject),
    };
  };
}
