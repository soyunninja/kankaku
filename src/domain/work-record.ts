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
 * Identity of the tracked ancestor process a `subagent` record discovered
 * via the machine-wide process registry (`~/.kankaku/run/<pid>.json`, see
 * `ports/process-registry.ts`). Used to reunite a cross-worktree child with
 * its orchestrator locally, before `buildTasks` runs (ADR 0023) — never
 * set on an `orchestrator` record.
 */
export interface OrchestratorRef {
  pid: number;
  project: string;
  startedAt: string;
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
  /**
   * `true` when at least one turn of this run reported a real (finite)
   * provider `cost` figure — as opposed to every turn's cost being
   * absent/non-finite (a subscription/OAuth provider that reports token
   * usage but no cost). Omitted (never `false`) when no turn ever observed
   * one, so an old persisted record without this field reads exactly the
   * same as a run that genuinely never saw a cost figure — both correctly
   * map to `cost_quality: "unknown"` in `domain/hub-entry.ts`. Optional:
   * adding it did not bump `WORK_RECORD_SCHEMA`.
   */
  costObserved?: true;
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
  /** Who this work is billed to. See {@link resolveClient} in `client-label.ts`. */
  client?: string;
  /** pi's session display name at the time this record settled. */
  sessionName?: string;
  /**
   * Absolute session directory, set only when pi's session manager reports
   * it as *non-default* (`SessionManager#usesDefaultSessionDir()` false) —
   * exactly the condition under which pi's own `formatResumeCommand` adds
   * `--session-dir` to the printed resume command. Omitted for an ordinary
   * default-location session, so most records never carry this at all.
   * Local-only today: the hub has no field for it yet (see README
   * "Subagents" / AGENTS.md for the recommended `session_dir` migration).
   */
  sessionDir?: string;
  /** Hub (PocketBase) client record id, when a hub target is active for this run. See `domain/work-target.ts`. */
  clientId?: string;
  /** Hub client display name, denormalised alongside `clientId` for readability. */
  clientName?: string;
  /** Hub (PocketBase) project record id, when the active hub target has a project. */
  projectId?: string;
  /** Hub project display name, denormalised alongside `projectId`. */
  projectName?: string;
  /** This machine's hostname, or `KANKAKU_MACHINE`, set only when the hub is configured. */
  machine?: string;
  /**
   * Set only on an `orchestrator` record that could not be positively
   * proven top-level (ADR 0022's four-state classification, applied on top
   * of this still-binary `role`): no recognised child-env-marker matched,
   * but a live tracked ancestor process was found in the machine-wide
   * registry. Never counted as a new task locally or synced to the hub
   * until the ambiguity is resolved (see README "Subagents"). Omitted
   * entirely for a confirmed orchestrator, so a record from a build
   * predating this field is indistinguishable from a confirmed one.
   */
  roleConfidence?: "uncertain";
  /**
   * The tracked ancestor a `subagent` record discovered via the
   * machine-wide process registry. See {@link OrchestratorRef}.
   */
  orchestratorRef?: OrchestratorRef;
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

/** A finite, non-negative number: durations such as `wallMs` can never be negative. */
function isNonNegativeFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOrchestratorRef(value: unknown): value is OrchestratorRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return typeof ref["pid"] === "number" && typeof ref["project"] === "string" && typeof ref["startedAt"] === "string";
}

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
    isNonNegativeFinite(record["wallMs"]) &&
    isNonNegativeFinite(record["waitingMs"]) &&
    isNonNegativeFinite(record["workMs"]) &&
    typeof record["runs"] === "number" &&
    typeof record["turns"] === "number" &&
    typeof record["tools"] === "object" &&
    record["tools"] !== null &&
    Array.isArray(record["subagents"]) &&
    typeof record["usage"] === "object" &&
    record["usage"] !== null &&
    STATUSES.has(record["status"] as WorkStatus) &&
    (record["client"] === undefined || typeof record["client"] === "string") &&
    (record["sessionName"] === undefined || typeof record["sessionName"] === "string") &&
    (record["sessionDir"] === undefined || typeof record["sessionDir"] === "string") &&
    (record["clientId"] === undefined || typeof record["clientId"] === "string") &&
    (record["clientName"] === undefined || typeof record["clientName"] === "string") &&
    (record["projectId"] === undefined || typeof record["projectId"] === "string") &&
    (record["projectName"] === undefined || typeof record["projectName"] === "string") &&
    (record["machine"] === undefined || typeof record["machine"] === "string") &&
    (record["roleConfidence"] === undefined || record["roleConfidence"] === "uncertain") &&
    (record["orchestratorRef"] === undefined || isOrchestratorRef(record["orchestratorRef"])) &&
    (record["costObserved"] === undefined || record["costObserved"] === true)
  );
}
