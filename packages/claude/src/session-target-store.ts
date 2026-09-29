import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * `<claude/>/<session_id>.target.json`: the session-only hub task link
 * picked with `/kankaku:task`. Kept out of `state.json` (which the hooks
 * rewrite constantly) and never written to the project's `config.json`.
 * `lastList` holds the ids of the last task list printed for this session,
 * so `task <n>` resolves against what the user actually saw. The link
 * fields are absent while only a list has been shown, or after a clear.
 * Node builtins only.
 */
export interface SessionTargetLink {
  hubTaskId?: string;
  hubTaskTitle?: string;
  projectId?: string;
  pickedAt?: number;
  lastList: string[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
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
  if (o.hubTaskId !== undefined && typeof o.hubTaskId !== "string") return undefined;
  if (o.lastList !== undefined && !Array.isArray(o.lastList)) return undefined;
  const hubTaskId = str(o.hubTaskId);
  const hubTaskTitle = str(o.hubTaskTitle);
  const projectId = str(o.projectId);
  return {
    ...(hubTaskId !== undefined ? { hubTaskId } : {}),
    ...(hubTaskId !== undefined && hubTaskTitle !== undefined ? { hubTaskTitle } : {}),
    ...(hubTaskId !== undefined && projectId !== undefined ? { projectId } : {}),
    ...(hubTaskId !== undefined && typeof o.pickedAt === "number" ? { pickedAt: o.pickedAt } : {}),
    lastList: (Array.isArray(o.lastList) ? o.lastList : []).filter((id): id is string => typeof id === "string"),
  };
}

/** Atomic tmp+rename write, creating parent directories as needed. */
export function writeSessionTarget(file: string, link: SessionTargetLink): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(link));
  renameSync(tmp, file);
}
