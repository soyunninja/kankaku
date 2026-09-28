import type { CatalogSnapshot } from "kankaku/ports";

/** Mirrors `CachedCatalog`'s own default TTL (`cached-catalog.ts`): six hours. */
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

export interface CatalogProjectRow {
  id: string;
  name: string;
  code?: string;
  openCount: number;
  doingCount: number;
}

export interface CatalogClientRow {
  id: string;
  name: string;
  code: string;
  projects: CatalogProjectRow[];
}

export type CatalogModel =
  | { status: "unavailable"; reason?: string }
  | {
      status: "ready";
      url: string;
      fetchedAt: number;
      ageMs: number;
      stale: boolean;
      clients: CatalogClientRow[];
    };

/**
 * Build a {@link CatalogModel} from a cached {@link CatalogSnapshot}:
 * active clients, each with its active projects (sorted by name) and their
 * open/doing hub task counts. `undefined` (no snapshot cached yet) reports
 * `"unavailable"`. `now` is injected (never `Date.now()` here) so age and
 * staleness stay deterministic under test.
 */
export function buildCatalogModel(snapshot: CatalogSnapshot | undefined, now: number, staleMs: number = DEFAULT_STALE_MS): CatalogModel {
  if (!snapshot) return { status: "unavailable" };

  const taskCountsByProject = new Map<string, { open: number; doing: number }>();
  for (const task of snapshot.tasks ?? []) {
    const counts = taskCountsByProject.get(task.projectId) ?? { open: 0, doing: 0 };
    if (task.status === "open") counts.open += 1;
    else if (task.status === "doing") counts.doing += 1;
    taskCountsByProject.set(task.projectId, counts);
  }

  const clients: CatalogClientRow[] = snapshot.clients
    .filter((client) => client.active)
    .map((client) => ({
      id: client.id,
      name: client.name,
      code: client.code,
      projects: snapshot.projects
        .filter((project) => project.active && project.clientId === client.id)
        .map((project) => {
          const counts = taskCountsByProject.get(project.id) ?? { open: 0, doing: 0 };
          return {
            id: project.id,
            name: project.name,
            ...(project.code !== undefined ? { code: project.code } : {}),
            openCount: counts.open,
            doingCount: counts.doing,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const ageMs = now - snapshot.fetchedAt;
  return { status: "ready", url: snapshot.url, fetchedAt: snapshot.fetchedAt, ageMs, stale: ageMs > staleMs, clients };
}
