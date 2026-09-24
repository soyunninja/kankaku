import { buildTasks } from "kankaku/domain";
import type { TaskView, WorkRecord, WorkStatus } from "kankaku/domain";

export interface FormatReportOptions {
  /** Epoch ms "now" the window is measured back from. */
  now: number;
  /** How many trailing local days to include. Defaults to 7. */
  days?: number;
}

const STATUS_WORD: Record<WorkStatus, string> = {
  completed: "done",
  interrupted: "interrupted",
  aborted: "aborted",
};

const PROMPT_MAX_LENGTH = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Renders a per-day, per-task report from raw {@link WorkRecord}s: builds
 * {@link TaskView}s via `buildTasks`, keeps the ones started within the
 * last `opts.days` local days (default 7), groups by local calendar day,
 * and lists one line per task plus a per-day and a grand total.
 */
export function formatReport(records: WorkRecord[], opts: FormatReportOptions): string {
  const days = opts.days ?? 7;
  const cutoff = opts.now - days * MS_PER_DAY;

  const tasks = buildTasks(records).filter((task) => new Date(task.startedAt).getTime() >= cutoff);

  if (tasks.length === 0) {
    return `No tasks recorded in the last ${days} days.\n`;
  }

  const byDay = new Map<string, TaskView[]>();
  for (const task of tasks) {
    const day = localDay(task.startedAt);
    const group = byDay.get(day);
    if (group) group.push(task);
    else byDay.set(day, [task]);
  }

  const lines: string[] = [];
  let grand = emptyTotals();

  for (const day of [...byDay.keys()].sort()) {
    const dayTasks = byDay.get(day)!.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    lines.push(day);
    let dayTotals = emptyTotals();
    for (const task of dayTasks) {
      lines.push(`  ${formatTaskLine(task)}`);
      dayTotals = addTotals(dayTotals, totalsOf(task));
    }
    lines.push(`  ${formatTotalsLine(dayTasks.length, dayTotals)}`);
    grand = addTotals(grand, dayTotals);
  }

  const grandTaskCount = tasks.length;
  lines.push("");
  lines.push(`Grand ${formatTotalsLine(grandTaskCount, grand)}`);

  return lines.join("\n") + "\n";
}

interface Totals {
  wallMs: number;
  waitingMs: number;
  workMs: number;
  cost: number;
}

function emptyTotals(): Totals {
  return { wallMs: 0, waitingMs: 0, workMs: 0, cost: 0 };
}

function totalsOf(task: TaskView): Totals {
  return { wallMs: task.wallMs, waitingMs: task.waitingMs, workMs: task.workMs, cost: task.usage.cost };
}

function addTotals(a: Totals, b: Totals): Totals {
  return {
    wallMs: a.wallMs + b.wallMs,
    waitingMs: a.waitingMs + b.waitingMs,
    workMs: a.workMs + b.workMs,
    cost: a.cost + b.cost,
  };
}

function formatTaskLine(task: TaskView): string {
  const time = localTime(task.startedAt);
  const status = STATUS_WORD[task.status] ?? task.status;
  const cost = task.usage.cost > 0 ? `$${task.usage.cost.toFixed(2)}` : "-";
  const prompt = truncatePrompt(task.prompt);
  return `${time}  ${status}  wall ${formatDuration(task.wallMs)}  wait ${formatDuration(task.waitingMs)}  work ${formatDuration(task.workMs)}  ${cost}  ${prompt}`;
}

function formatTotalsLine(taskCount: number, totals: Totals): string {
  const label = taskCount === 1 ? "task" : "tasks";
  return `total: ${taskCount} ${label}  wall ${formatDuration(totals.wallMs)}  wait ${formatDuration(totals.waitingMs)}  work ${formatDuration(totals.workMs)}  $${totals.cost.toFixed(2)}`;
}

/** `1h 02m`, `12m 05s`, or `8s` — matches the spec's examples exactly. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`;
  return `${seconds}s`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function truncatePrompt(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= PROMPT_MAX_LENGTH) return singleLine;
  return `${singleLine.slice(0, PROMPT_MAX_LENGTH - 1)}…`;
}

function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localTime(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
