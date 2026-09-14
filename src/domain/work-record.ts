/** Current schema version for {@link WorkRecord}. */
export const WORK_RECORD_SCHEMA = 1;

export type WorkRole = "orchestrator" | "subagent";

export type WorkStatus = "completed" | "aborted" | "interrupted";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SubagentSpan {
  toolCallId: string;
  agent: string;
  mode: string;
  taskId?: string;
  ms: number;
}

/**
 * Fields the pure {@link WorkTracker} state machine can compute on its own,
 * with no knowledge of the pi process or session it runs in.
 */
export interface WorkRecordCore {
  schema: number;
  id: string;
  prompt: string;
  startedAt: string;
  settledAt: string;
  wallMs: number;
  waitingMs: number;
  workMs: number;
  runs: number;
  turns: number;
  tools: Record<string, number>;
  subagents: SubagentSpan[];
  /**
   * Union milliseconds per tag spent in tool calls matched by a
   * {@link SegmentRule} (e.g. `review`). Optional so older persisted
   * records without this field still satisfy the type; callers reading
   * from disk should treat a missing value as `{}`.
   */
  segments?: Record<string, number>;
  usage: UsageTotals;
  status: WorkStatus;
}

/** Process/session metadata the adapter layer attaches before persisting a record. */
export interface WorkRecordMetadata {
  role: WorkRole;
  pid: number;
  parentPid: number;
  project: string;
  sessionId?: string;
  sessionFile?: string;
  mode?: string;
  model?: string;
}

export type WorkRecord = WorkRecordCore & WorkRecordMetadata;

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** A finite number, or `0` for `undefined`/`NaN`/`Infinity`/non-numbers. */
export function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const ROLES = new Set<WorkRole>(["orchestrator", "subagent"]);
const STATUSES = new Set<WorkStatus>(["completed", "aborted", "interrupted"]);

/**
 * Runtime guard for a {@link WorkRecord} read back from disk. `readAll`
 * skips lines that parse as JSON but fail this check, so a torn write or a
 * record from an incompatible schema does not crash task/session views.
 */
export function isWorkRecord(value: unknown): value is WorkRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  return (
    typeof record["schema"] === "number" &&
    typeof record["id"] === "string" &&
    ROLES.has(record["role"] as WorkRole) &&
    typeof record["pid"] === "number" &&
    typeof record["parentPid"] === "number" &&
    typeof record["project"] === "string" &&
    typeof record["prompt"] === "string" &&
    typeof record["startedAt"] === "string" &&
    typeof record["settledAt"] === "string" &&
    Number.isFinite(record["wallMs"]) &&
    Number.isFinite(record["waitingMs"]) &&
    Number.isFinite(record["workMs"]) &&
    typeof record["runs"] === "number" &&
    typeof record["turns"] === "number" &&
    typeof record["tools"] === "object" &&
    record["tools"] !== null &&
    Array.isArray(record["subagents"]) &&
    typeof record["usage"] === "object" &&
    record["usage"] !== null &&
    STATUSES.has(record["status"] as WorkStatus)
  );
}
