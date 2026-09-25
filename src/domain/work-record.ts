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
  /**
   * The {@link SubagentProfile}'s `id` that matched this tool call
   * (`domain/subagent-profile.ts`, ADR 0020), when unambiguous. Omitted
   * when no profile's tool name matched at all, or when 2+ profiles
   * registered the same tool name and could not be told apart
   * (SUBAGENT-REQ-005) — `/kankaku doctor` surfaces both cases. Optional so
   * an older-format span (written before profiles existed) still validates.
   */
  profile?: string;
  /**
   * C1 (CRITICAL fix, SUBAGENT-REQ-006 revised): nested LLM usage the
   * matched profile's `readResult` forwarded from this span's tool result,
   * kept SEPARATE from the orchestrator's own `WorkRecordCore.usage` —
   * never folded in at write time (`domain/work-tracker.ts#onToolEnd`).
   * `domain/task-view.ts#buildTasks` (ADR 0006: aggregation across
   * spans/children stays in exactly this one place) is the only place that
   * decides whether to add it to a task's total, based on whether a joined
   * child record with the SAME `profile` already carries this same cost
   * through its own confirmed-marker ancestry join — see
   * `task-view.ts#unjoinedForwardedUsage`. Never set for an ambiguous
   * tool-name match (nothing money-affecting is ever taken from one — see
   * `domain/subagent-profile.ts#safeAmbiguousResultInfo`) or when the
   * matched profile's `readResult` reported no usage at all. Optional so an
   * older-format span (written before this field existed) still validates.
   */
  forwardedUsage?: Partial<UsageTotals>;
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
  /**
   * The real orchestrator's resolved, absolute kankaku directory (its
   * `RegistryEntry.dir`), when known — carried through a nested
   * subagent-of-subagent chain via `domain/ancestry-match.ts#resolveOrchestratorRef`
   * so a grandchild can route its writes (F1) straight to the true root's
   * directory without a fresh registry lookup for an ancestor that may no
   * longer even be alive. Optional so an older-format entry/record (written
   * before this field existed) still validates and — when absent — the
   * reader simply falls back to its own local directory rather than
   * routing anywhere (see `adapters/extension.ts`'s write-routing).
   */
  dir?: string;
}

/**
 * Fields the pure {@link WorkTracker} state machine can compute on its own,
 * with no knowledge of the pi process or session it runs in.
 */
/** What started a record: absent = a user prompt (every record before this field existed). */
export type RunTrigger = "extension";

/** The `prompt` of a record no user prompt started — see {@link RunTrigger}. */
export const EXTENSION_RUN_PROMPT = "(no user prompt — run started by an extension)";

export interface WorkRecordCore {
  schema: number;
  id: string;
  prompt: string;
  /**
   * `"extension"` when an extension, not the user, started this record's
   * first run (e.g. gentle-pi waking the orchestrator because a background
   * subagent finished). Optional and additive: `WORK_RECORD_SCHEMA` is
   * unchanged and an older record without it still validates.
   */
  trigger?: RunTrigger;
  startedAt: string;
  settledAt: string;
  wallMs: number;
  waitingMs: number;
  workMs: number;
  /**
   * Agent loops inside this record: the first one plus every
   * `agent.continue()` pi ran before settling it (auto-retry after a provider
   * error, overflow recovery, a queued steer/follow-up). Informational only —
   * never used for time or cost.
   */
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
  /**
   * The model's reasoning effort when the record settled, as pi names it
   * (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). Optional and
   * additive; absent on older records and on a pi too old to report it.
   */
  thinkingLevel?: string;
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
  /** Hub `tasks` record id linked for this session (`/kankaku task pick`), when one is active. See `domain/work-target.ts#HubTask`. */
  hubTaskId?: string;
  /** Hub task title, denormalised alongside `hubTaskId`. */
  hubTaskTitle?: string;
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
  /**
   * The {@link SubagentProfile} `id` (ADR 0020) whose child-env marker(s)
   * confirmed THIS process's `role: "subagent"` classification — e.g.
   * `"gentle-pi"` or `"pi-subagents"`. Set only when exactly one profile's
   * marker matched (SUBAGENT-REQ-005 never guesses); omitted when this
   * process's role came from ancestry alone (no known marker present, e.g.
   * pi's bundled reference example) or from 2+ markers matching at once.
   * `/kankaku doctor` reports which profile matched each record
   * (SUBAGENT-REQ-017). Never set on an `orchestrator` record.
   */
  profile?: string;
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
  return (
    typeof ref["pid"] === "number" &&
    typeof ref["project"] === "string" &&
    typeof ref["startedAt"] === "string" &&
    (ref["dir"] === undefined || typeof ref["dir"] === "string")
  );
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
    (record["thinkingLevel"] === undefined || typeof record["thinkingLevel"] === "string") &&
    (record["clientId"] === undefined || typeof record["clientId"] === "string") &&
    (record["clientName"] === undefined || typeof record["clientName"] === "string") &&
    (record["projectId"] === undefined || typeof record["projectId"] === "string") &&
    (record["projectName"] === undefined || typeof record["projectName"] === "string") &&
    (record["hubTaskId"] === undefined || typeof record["hubTaskId"] === "string") &&
    (record["hubTaskTitle"] === undefined || typeof record["hubTaskTitle"] === "string") &&
    (record["machine"] === undefined || typeof record["machine"] === "string") &&
    (record["roleConfidence"] === undefined || record["roleConfidence"] === "uncertain") &&
    (record["orchestratorRef"] === undefined || isOrchestratorRef(record["orchestratorRef"])) &&
    (record["costObserved"] === undefined || record["costObserved"] === true) &&
    (record["profile"] === undefined || typeof record["profile"] === "string")
  );
}
