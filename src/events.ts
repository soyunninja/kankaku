/**
 * The append-only event line format written to
 * `<KANKAKU_DIR>/claude/<session_id>.events.jsonl`. One line per hook
 * invocation, minimal fields only — see AGENTS.md / odd/tasks/hook-tracking.md
 * "Event line".
 */

export interface UserPromptSubmitEvent {
  ts: number;
  event: "UserPromptSubmit";
  prompt: string;
  promptId?: string;
}

export interface PreToolUseEvent {
  ts: number;
  event: "PreToolUse";
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface PostToolUseEvent {
  ts: number;
  event: "PostToolUse";
  toolUseId: string;
  toolName: string;
}

export interface PermissionRequestEvent {
  ts: number;
  event: "PermissionRequest";
  toolUseId: string;
  toolName: string;
}

export interface SubagentStartEvent {
  ts: number;
  event: "SubagentStart";
  agentId: string;
  agentType: string;
}

export interface SubagentStopEvent {
  ts: number;
  event: "SubagentStop";
  agentId: string;
  agentType: string;
}

export interface StopEvent {
  ts: number;
  event: "Stop";
  stopHookActive: boolean;
}

export interface SessionStartEvent {
  ts: number;
  event: "SessionStart";
  source: string;
}

export interface SessionEndEvent {
  ts: number;
  event: "SessionEnd";
  reason: string;
}

export type Event =
  | UserPromptSubmitEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | PermissionRequestEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | StopEvent
  | SessionStartEvent
  | SessionEndEvent;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const validators: Record<string, (o: Record<string, unknown>) => boolean> = {
  UserPromptSubmit: (o) =>
    isString(o.prompt) && (o.promptId === undefined || isString(o.promptId)),
  PreToolUse: (o) =>
    isString(o.toolUseId) && isString(o.toolName) && isPlainObject(o.toolInput),
  PostToolUse: (o) => isString(o.toolUseId) && isString(o.toolName),
  PermissionRequest: (o) => isString(o.toolUseId) && isString(o.toolName),
  SubagentStart: (o) => isString(o.agentId) && isString(o.agentType),
  SubagentStop: (o) => isString(o.agentId) && isString(o.agentType),
  Stop: (o) => typeof o.stopHookActive === "boolean",
  SessionStart: (o) => isString(o.source),
  SessionEnd: (o) => isString(o.reason),
};

/** One JSON line, no trailing newline. */
export function serializeEvent(event: Event): string {
  return JSON.stringify(event);
}

/**
 * Parses one event line. Never throws: malformed JSON, a non-object value,
 * an unknown `event` name, or a known event missing/mistyping a required
 * field all return `undefined` instead.
 */
export function parseEventLine(line: string): Event | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  if (!isFiniteNumber(parsed.ts)) return undefined;
  if (!isString(parsed.event)) return undefined;
  const validate = validators[parsed.event];
  if (!validate) return undefined;
  if (!validate(parsed)) return undefined;
  return parsed as unknown as Event;
}

/**
 * Parses every line of an events file. Tolerant of blank lines and of a
 * truncated last line (a partial write left by a crash): any line that
 * fails to parse is simply skipped, never thrown.
 */
export function readEvents(text: string): Event[] {
  const events: Event[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const event = parseEventLine(line);
    if (event) events.push(event);
  }
  return events;
}
