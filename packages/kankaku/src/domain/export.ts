import { localDay } from "./day.ts";
import { finiteOrZero } from "./work-record.ts";
import type { WorkStatus } from "./work-record.ts";
import type { TaskView } from "./task-view.ts";

/** One flat, spreadsheet-friendly row per {@link TaskView}. */
export interface ExportRow {
  id: string;
  /** Local calendar day (`YYYY-MM-DD`) the task started on. */
  day: string;
  startedAt: string;
  endedAt: string;
  /** Empty string when the task has no resolved client. */
  client: string;
  /** Empty string when the orchestrator record has no session name. */
  sessionName: string;
  /** Empty string when the orchestrator record has no session id. */
  sessionId: string;
  project: string;
  status: WorkStatus;
  /** First 200 chars of the task's prompt, with newlines collapsed to spaces. */
  prompt: string;
  wallMs: number;
  waitingMs: number;
  workMs: number;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  subagentCount: number;
  /** JSON-encoded `TaskView.segments` map. */
  segments: string;
  /** Empty string when the orchestrator record has no model. */
  model: string;
}

/** First 200 chars of `prompt`, with `\n`/`\r` collapsed to a single space. */
function truncatePrompt(prompt: string): string {
  return prompt.slice(0, 200).replace(/\r\n|\r|\n/g, " ");
}

/** Build one flat {@link ExportRow} per task, in the same order as `tasks`. */
export function exportRows(tasks: TaskView[]): ExportRow[] {
  return tasks.map((task) => ({
    id: task.id,
    day: localDay(task.startedAt),
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    client: task.client ?? "",
    sessionName: task.sessionName ?? "",
    sessionId: task.sessionId ?? "",
    project: task.project,
    status: task.status,
    prompt: truncatePrompt(task.prompt),
    wallMs: task.wallMs,
    waitingMs: task.waitingMs,
    workMs: task.workMs,
    cost: finiteOrZero(task.usage.cost),
    tokensIn: finiteOrZero(task.usage.input),
    tokensOut: finiteOrZero(task.usage.output),
    cacheRead: finiteOrZero(task.usage.cacheRead),
    subagentCount: task.subagents.length,
    segments: JSON.stringify(task.segments),
    model: task.orchestrator.model ?? "",
  }));
}

/** Column order for {@link toCsv}'s header row, matching {@link ExportRow}'s field order. */
const COLUMNS: Array<keyof ExportRow> = [
  "id",
  "day",
  "startedAt",
  "endedAt",
  "client",
  "sessionName",
  "sessionId",
  "project",
  "status",
  "prompt",
  "wallMs",
  "waitingMs",
  "workMs",
  "cost",
  "tokensIn",
  "tokensOut",
  "cacheRead",
  "subagentCount",
  "segments",
  "model",
];

/** RFC 4180 field quoting: quote a field containing `,`, `"`, or a newline; double any embedded quote. */
function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Render `rows` as RFC 4180 CSV: a header row, one row per record, `\n` line endings. */
export function toCsv(rows: ExportRow[]): string {
  const lines = [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((column) => csvField(row[column])).join(","))];
  return lines.join("\n");
}

/** Render `rows` as pretty-printed (2-space indent) JSON. */
export function toJson(rows: ExportRow[]): string {
  return JSON.stringify(rows, null, 2);
}
