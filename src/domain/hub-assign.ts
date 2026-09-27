/**
 * Reassigning an already-synced `task_entries` row: pure matching and
 * payload building, no I/O.
 *
 * Once a row exists, the hub is the source of truth for its assignment
 * (README "Hub (PocketBase)" > "Assignment is create-only"): a re-sync
 * never touches `client`/`project`/`task`/`legacy_client_label` again.
 * This module is what lets a human move a mis-assigned row from pi
 * instead of the web app, and it deliberately builds **only** the exact
 * `{ client, project }` pair — never any other `task_entries` field.
 *
 * Client matching mirrors `/kankaku client <name>` (`kankaku-command.ts`):
 * a case-insensitive exact match of a client `code` or `name`, over the
 * assignable clients only (active, and never the "Sin determinar" row).
 * Project matching is the same rule over active projects, looked up
 * regardless of client so "this project belongs to someone else" can be
 * told apart from "no such project".
 */

import type { CatalogSnapshot } from "../ports/catalog.ts";
import type { Client, Project } from "./work-target.ts";

/** The only two `task_entries` fields a reassignment may ever send. */
export interface HubAssignPayload {
  /** `clients` relation id. */
  client: string;
  /** `projects` relation id, or `""` when the row should have no project. */
  project: string;
}

/**
 * The outcome of resolving a client/project reference pair:
 *
 * - `resolved`: both references matched (or the project was omitted, which
 *   clears the relation) and `payload` is the exact pair to PATCH.
 * - `client-not-found`: the client reference matched no assignable client.
 * - `project-not-found`: the project reference matched no active project.
 * - `project-not-in-client`: the project is active and exists, but belongs
 *   to a different client than the one chosen.
 */
export type HubAssignResolution =
  | { kind: "resolved"; payload: HubAssignPayload; client: Client; project?: Project }
  | { kind: "client-not-found"; reference: string }
  | { kind: "project-not-found"; reference: string }
  | { kind: "project-not-in-client"; reference: string; client: Client };

/** A client usable as a reassignment target: exists, active, and not the "unassigned" row. Mirrors `/kankaku client <name>`. */
export function findAssignableClient(clients: Client[], reference: string): Client | undefined {
  const lower = reference.toLowerCase();
  return clients.find(
    (client) => client.active && !client.unassigned && (client.code.toLowerCase() === lower || client.name.toLowerCase() === lower),
  );
}

/** A project usable as a reassignment target: exists and is active, whichever client it belongs to. */
export function findAssignableProject(projects: Project[], reference: string): Project | undefined {
  const lower = reference.toLowerCase();
  return projects.find(
    (project) => project.active && (project.code?.toLowerCase() === lower || project.name.toLowerCase() === lower),
  );
}

/**
 * Resolve a client and (optional) project reference against the catalog
 * snapshot and build the exact `{ client, project }` PATCH payload.
 *
 * `projectReference === undefined` means "no project": the payload clears
 * the relation (`project: ""`) rather than leaving it untouched, since the
 * hub PATCH always writes both keys of the pair.
 */
export function resolveHubAssignment(
  snapshot: CatalogSnapshot,
  clientReference: string,
  projectReference: string | undefined,
): HubAssignResolution {
  const client = findAssignableClient(snapshot.clients, clientReference);
  if (!client) return { kind: "client-not-found", reference: clientReference };

  if (projectReference === undefined) {
    return { kind: "resolved", payload: { client: client.id, project: "" }, client };
  }

  const project = findAssignableProject(snapshot.projects, projectReference);
  if (!project) return { kind: "project-not-found", reference: projectReference };
  if (project.clientId !== client.id) {
    return { kind: "project-not-in-client", reference: projectReference, client };
  }

  return { kind: "resolved", payload: { client: client.id, project: project.id }, client, project };
}
