import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * `<claude/>/<session_id>.target.json`: the session-only choices made with
 * `/kankaku:task` (the hub task link) and `/kankaku:target` (the client and
 * project override). Kept out of `state.json` (which the hooks rewrite
 * constantly) and never written to the project's `config.json`.
 *
 * `lastList` is the last numbered list printed for this session, typed so a
 * number always means the list the user actually saw (`clients`,
 * `projects` of the session's client, or `tasks`). The link and target
 * fields are absent while only a list has been shown, or after a clear.
 * `projectId` is the project of the session target and of the linked task
 * (they are the same by the task-link rule). It only counts as an override
 * together with `clientId`. Node builtins only.
 */
export type SessionListKind = "clients" | "projects" | "tasks";

export interface SessionList {
  kind: SessionListKind;
  ids: string[];
}

export interface SessionTargetLink {
  hubTaskId?: string;
  hubTaskTitle?: string;
  projectId?: string;
  pickedAt?: number;
  clientId?: string;
  pickedTargetAt?: number;
  lastList: SessionList;
}

const LIST_KINDS: readonly string[] = ["clients", "projects", "tasks"];

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function strings(value: unknown[]): string[] {
  return value.filter((id): id is string => typeof id === "string");
}

/** A plain array is the pre-`target` format: the ids of a task list. `undefined` when malformed. */
function readList(value: unknown): SessionList | undefined {
  if (value === undefined) return { kind: "tasks", ids: [] };
  if (Array.isArray(value)) return { kind: "tasks", ids: strings(value) };
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, ids } = value as Record<string, unknown>;
  if (typeof kind !== "string" || !LIST_KINDS.includes(kind) || !Array.isArray(ids)) return undefined;
  return { kind: kind as SessionListKind, ids: strings(ids) };
}

/** `undefined` when the file is absent or malformed. Extra or invalid fields are dropped. */
export function readSessionTarget(file: string): SessionTargetLink | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const o = parsed as Record<string, unknown>;
  for (const key of ["hubTaskId", "clientId", "projectId"]) {
    if (o[key] !== undefined && typeof o[key] !== "string") return undefined;
  }
  const lastList = readList(o.lastList);
  if (lastList === undefined) return undefined;
  const hubTaskId = str(o.hubTaskId);
  const hubTaskTitle = str(o.hubTaskTitle);
  const clientId = str(o.clientId);
  const projectId = hubTaskId !== undefined || clientId !== undefined ? str(o.projectId) : undefined;
  return {
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientId !== undefined && typeof o.pickedTargetAt === "number" ? { pickedTargetAt: o.pickedTargetAt } : {}),
    ...(hubTaskId !== undefined ? { hubTaskId } : {}),
    ...(hubTaskId !== undefined && hubTaskTitle !== undefined ? { hubTaskTitle } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(hubTaskId !== undefined && typeof o.pickedAt === "number" ? { pickedAt: o.pickedAt } : {}),
    lastList,
  };
}

/** The same file content without the task link (the target and the list are kept). */
export function withoutTaskLink(link: SessionTargetLink): SessionTargetLink {
  const { hubTaskId: _id, hubTaskTitle: _title, pickedAt: _at, projectId, ...rest } = link;
  return { ...rest, ...(link.clientId !== undefined && projectId !== undefined ? { projectId } : {}) };
}

/** Atomic tmp+rename write, creating parent directories as needed. */
export function writeSessionTarget(file: string, link: SessionTargetLink): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(link));
  renameSync(tmp, file);
}
