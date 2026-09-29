import type { HubTask } from "kankaku/domain";

/**
 * Pure task selection for `/kankaku:task`. Mirrors pi's picker
 * (`adapters/target-picker.ts#pickHubTask`): a task is pickable when its
 * status is not `done` (the hub's statuses are `open | doing | done`, see
 * `HubTask` in `kankaku/domain`) and it belongs to the resolved project.
 */
export function isOpenTask(task: HubTask): boolean {
  return task.status !== "done";
}

/** The project's open tasks, sorted by title (the order the list is numbered in). */
export function listOpenTasks(tasks: HubTask[], projectId: string): HubTask[] {
  return tasks
    .filter((task) => task.projectId === projectId && isOpenTask(task))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export type TaskSelection =
  | { kind: "picked"; task: HubTask }
  | { kind: "ambiguous"; candidates: HubTask[] }
  | { kind: "unknown"; message: string };

export interface TaskSelectionContext {
  /** The project's open tasks, from {@link listOpenTasks}. Nothing outside it is ever selectable. */
  open: HubTask[];
  /** Ids of the last list printed for this session, in the order shown. */
  lastList: string[];
}

/**
 * `arg` is one of: a list number (a purely numeric argument is ALWAYS a
 * number, never an id), a hub id, or a case-insensitive title substring
 * that must match exactly one open task.
 */
export function selectTask(arg: string, ctx: TaskSelectionContext): TaskSelection {
  const text = arg.trim();
  if (text === "") return { kind: "unknown", message: "no task given" };

  if (/^-?\d+$/.test(text)) return selectByNumber(Number(text), ctx);

  const byId = ctx.open.find((task) => task.id === text);
  if (byId) return { kind: "picked", task: byId };

  const needle = text.toLowerCase();
  const matches = ctx.open.filter((task) => task.title.toLowerCase().includes(needle));
  if (matches.length === 1) return { kind: "picked", task: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  return { kind: "unknown", message: `no open task matches "${text}"` };
}

function selectByNumber(n: number, ctx: TaskSelectionContext): TaskSelection {
  if (ctx.lastList.length === 0) {
    return { kind: "unknown", message: "no task list shown yet in this session; list the tasks first" };
  }
  if (!Number.isSafeInteger(n) || n < 1 || n > ctx.lastList.length) {
    return { kind: "unknown", message: `${n} is not on the list (1-${ctx.lastList.length})` };
  }
  const id = ctx.lastList[n - 1]!;
  const task = ctx.open.find((candidate) => candidate.id === id);
  if (!task) return { kind: "unknown", message: `task ${n} is no longer open; list the tasks again` };
  return { kind: "picked", task };
}
