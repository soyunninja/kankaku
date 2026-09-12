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
