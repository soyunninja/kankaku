import { buildTasks, cacheHitRatio, localDay } from "kankaku-pi/domain";
import type { TaskView, WorkRecord } from "kankaku-pi/domain";

/** Maximum visible width of a task prompt before it is truncated with an ellipsis marker. */
const PROMPT_DISPLAY_LIMIT = 40;

export interface TaskRow {
  id: string;
  /** `HH:MM`, local time. */
  time: string;
  /** Project (directory) name this task's worklog came from. */
  project: string;
  clientName?: string;
  projectName?: string;
  hubTaskTitle?: string;
  wallMs: number;
  workMs: number;
  waitingMs: number;
  cost: number;
  cacheHit?: number;
  /** Number of subagent records joined to this task (`task-view.ts`'s own join, never re-derived here). */
  subagentCount: number;
  /** Truncated to `PROMPT_DISPLAY_LIMIT` visible characters, `…` marks a cut. */
  prompt: string;
  /** The untruncated prompt, for the Tasks detail panel. */
  fullPrompt: string;
}

export interface TasksModel {
  rows: TaskRow[];
}

export interface TasksModelOptions {
  /** Include every task regardless of day. Defaults to `false` (today only). */
  all?: boolean;
  /** Local day (`YYYY-MM-DD`) to restrict rows to when `all` is not set. Defaults to today. */
  today?: string;
}

export interface TasksProjectInput {
  name: string;
  records: WorkRecord[];
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Truncate `text` to `limit` visible characters, appending `…` (counted within the limit) when it was cut. Collapses internal whitespace first, since a prompt often spans several lines. */
function truncatePrompt(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function toRow(project: string, task: TaskView): TaskRow {
  return {
    id: task.id,
    time: formatTime(task.startedAt),
    project,
    ...(task.clientName !== undefined ? { clientName: task.clientName } : {}),
    ...(task.projectName !== undefined ? { projectName: task.projectName } : {}),
    ...(task.hubTaskTitle !== undefined ? { hubTaskTitle: task.hubTaskTitle } : {}),
    wallMs: task.wallMs,
    workMs: task.workMs,
    waitingMs: task.waitingMs,
    cost: task.usage.cost,
    ...(cacheHitRatio(task.usage) !== undefined ? { cacheHit: cacheHitRatio(task.usage) } : {}),
    subagentCount: task.subagents.length,
    prompt: truncatePrompt(task.prompt, PROMPT_DISPLAY_LIMIT),
    fullPrompt: task.prompt,
  };
}

/**
 * Build one {@link TaskRow} per task (via kankaku's own `buildTasks`, never
 * reimplementing its orchestrator/subagent join) across every project,
 * newest first. Restricted to `options.today` (default: today) unless
 * `options.all` is set.
 */
export function buildTasksModel(projects: TasksProjectInput[], options: TasksModelOptions = {}): TasksModel {
  const targetDay = options.all ? undefined : (options.today ?? localDay(new Date().toISOString()));

  const entries: Array<{ project: string; task: TaskView }> = [];
  for (const project of projects) {
    for (const task of buildTasks(project.records)) {
      if (targetDay !== undefined && localDay(task.startedAt) !== targetDay) continue;
      entries.push({ project: project.name, task });
    }
  }

  entries.sort((a, b) => Date.parse(b.task.startedAt) - Date.parse(a.task.startedAt) || b.task.id.localeCompare(a.task.id));
  return { rows: entries.map((entry) => toRow(entry.project, entry.task)) };
}
