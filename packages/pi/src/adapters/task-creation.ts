import type { HubTask } from "../domain/work-target.ts";
import type { TaskCreator } from "./target-picker.ts";
import { CatalogAdoptionFailure } from "./cached-catalog.ts";
import { PocketBaseError } from "./pocketbase-client.ts";

export class TaskCreationFailure extends Error {
  readonly kind: "request" | "cache-persistence" | "catalog-unavailable";
  readonly task: HubTask | undefined;
  readonly source: unknown;

  constructor(kind: "request" | "cache-persistence" | "catalog-unavailable", task?: HubTask, source?: unknown) {
    super(kind === "request" ? "Task creation request failed" : "Task was created but could not be adopted locally");
    this.name = "TaskCreationFailure";
    this.kind = kind;
    this.task = task;
    this.source = source;
  }
}

/** Compose the remote POST and local cache adoption without hiding known remote success. */
export function createTaskCreator(createRemote: TaskCreator, adopt: (task: HubTask) => void): TaskCreator {
  return async (projectId, title, externalRef) => {
    let task: HubTask;
    try {
      task = await createRemote(projectId, title, externalRef);
    } catch (error) {
      throw new TaskCreationFailure("request", undefined, error);
    }
    try {
      adopt(task);
    } catch (error) {
      const kind = error instanceof CatalogAdoptionFailure && error.reason === "persistence" ? "cache-persistence" : "catalog-unavailable";
      throw new TaskCreationFailure(kind, task);
    }
    return task;
  };
}

/** A bounded user-facing diagnostic; arbitrary exception text is never included. */
export function formatTaskCreationFailure(error: unknown): string {
  if (error instanceof TaskCreationFailure && error.kind === "cache-persistence") {
    return "kankaku: task created in the hub, but local catalog cache persistence failed; the task is linked to this session. The in-memory catalog remains available until restart.";
  }
  if (error instanceof TaskCreationFailure && error.kind === "catalog-unavailable") {
    return "kankaku: task created in the hub, but no local catalog snapshot was available to validate a session link. Refresh the catalog, then link the existing task; do not create it again.";
  }

  const source = error instanceof TaskCreationFailure ? error.source : error;
  let kind: string | undefined;
  let status: number | undefined;
  if (source instanceof PocketBaseError) {
    try {
      const candidateKind: unknown = source.kind;
      const candidateStatus: unknown = source.status;
      if (candidateKind === "network" || candidateKind === "timeout" || candidateKind === "http" || candidateKind === "auth") {
        kind = candidateKind;
      }
      if (typeof candidateStatus === "number" && Number.isInteger(candidateStatus) && candidateStatus >= 100 && candidateStatus <= 599) {
        status = candidateStatus;
      }
    } catch {
      // Malformed typed errors fall back to a generic diagnostic.
    }
  }
  const detail = [kind, status !== undefined ? String(status) : undefined].filter(Boolean).join(" ");
  const uncertain = kind === undefined || kind === "network" || kind === "timeout";
  return `kankaku: task creation was not confirmed${detail ? ` (${detail})` : ""}; ${uncertain ? "the outcome is uncertain; " : ""}check the hub before retrying.`;
}
