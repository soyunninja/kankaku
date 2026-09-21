import { unionMs } from "./intervals.ts";
import { emptyUsage, finiteOrZero } from "./work-record.ts";
import type { UsageTotals, WorkRecord, WorkStatus } from "./work-record.ts";

/**
 * One orchestrator run plus every subagent it spawned, with `wallMs`
 * recomputed as the union of the orchestrator's span and each child's span
 * — never their sum — because background children keep running in parallel
 * after the orchestrator settles.
 */
export interface TaskView {
  id: string;
  sessionId?: string;
  project: string;
  prompt: string;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  waitingMs: number;
  workMs: number;
  status: WorkStatus;
  orchestrator: WorkRecord;
  subagents: WorkRecord[];
  usage: UsageTotals;
  /** Who this task is billed to, from the orchestrator record only — subagent children do not carry their own. */
  client?: string;
  /** pi's session display name, from the orchestrator record. */
  sessionName?: string;
  /** Non-default session directory, from the orchestrator record. See `WorkRecordMetadata.sessionDir`. Local-only today — no hub field yet. */
  sessionDir?: string;
  /** Hub client record id, from the orchestrator record only. See `domain/work-target.ts`. */
  clientId?: string;
  /** Hub client display name, from the orchestrator record only. */
  clientName?: string;
  /** Hub project record id, from the orchestrator record only. */
  projectId?: string;
  /** Hub project display name, from the orchestrator record only. */
  projectName?: string;
  /**
   * Per-tag total milliseconds across the orchestrator and every subagent,
   * summed rather than unioned: unlike `wallMs`, segment intervals are not
   * persisted on disk, so once a record settles its per-tag total is all
   * that remains, and there is nothing left to union across records.
   */
  segments: Record<string, number>;
}

/** One or more tasks grouped by their pi session, with the same union rule. */
export interface SessionView {
  sessionId: string;
  project: string;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  waitingMs: number;
  workMs: number;
  tasks: TaskView[];
  usage: UsageTotals;
  /** Per-tag total milliseconds summed across the session's tasks. See {@link TaskView.segments}. */
  segments: Record<string, number>;
}

function toMs(iso: string): number {
  return Date.parse(iso);
}

/**
 * Sum per-tag milliseconds across several segment maps (older records
 * without one count as `{}`). Accumulated in a `Map`, then emitted via
 * `Object.fromEntries` (never `result[tag] = ...` on a plain object) so a
 * tag from a hand-edited worklog line named `__proto__` or `constructor`
 * becomes an own data property with the right total instead of silently
 * reading (and arithmetically corrupting) an inherited `Object.prototype`
 * value. Mirrors `work-tracker.ts`'s own segment-building convention.
 */
function sumSegments(segmentMaps: Array<Record<string, number> | undefined>): Record<string, number> {
  const totals = new Map<string, number>();
  for (const segments of segmentMaps) {
    for (const [tag, ms] of Object.entries(segments ?? {})) {
      totals.set(tag, (totals.get(tag) ?? 0) + ms);
    }
  }
  return Object.fromEntries(totals);
}

/**
 * Sum several {@link UsageTotals}, tolerating a missing entry (a record
 * without a `usage` field) and missing or non-finite numeric fields on an
 * entry — both treated as zero rather than corrupting the sum with
 * `undefined`/`NaN`.
 */
export function sumUsage(totals: Array<UsageTotals | undefined>): UsageTotals {
  const usage = emptyUsage();
  for (const total of totals) {
    usage.input += finiteOrZero(total?.input);
    usage.output += finiteOrZero(total?.output);
    usage.cacheRead += finiteOrZero(total?.cacheRead);
    usage.cacheWrite += finiteOrZero(total?.cacheWrite);
    usage.cost += finiteOrZero(total?.cost);
  }
  return usage;
}

/**
 * A record is only eligible to anchor a new task when it is a *confirmed*
 * orchestrator: `role === "orchestrator"` and not flagged `uncertain`
 * (ADR 0022). An uncertain record is never dropped — see
 * {@link uncertainRecords} — but it never anchors a task locally and is
 * therefore never synced as one either (SUBAGENT-REQ-014), since sync
 * (`adapters/sync-runner.ts`) uploads exactly what {@link buildTasks}
 * produces.
 */
function isConfirmedOrchestrator(record: WorkRecord): boolean {
  return record.role === "orchestrator" && record.roleConfidence !== "uncertain";
}

/**
 * Match every subagent record to the orchestrator record it belongs to:
 * `parentPid === orchestrator.pid` and the child's `startedAt` falls inside
 * the orchestrator's `[startedAt, settledAt]` window. `project` is a
 * *hint*, never a hard filter (ADR 0021, SUBAGENT-REQ-008): among several
 * candidates matching on pid/time (a reused pid, or a genuine cross-project
 * match), a same-project one is always preferred; a cross-project candidate
 * is only ever eligible here because its record already lives in the same
 * `worklog.jsonl` this array was read from — F1's write-side routing
 * (`extension.ts`, `domain/ancestry-match.ts#resolveOrchestratorRef`)
 * reunites a verified cross-worktree child with its orchestrator by writing
 * straight into the orchestrator's own directory, so no later registry
 * lookup is ever needed here — this function itself does no registry
 * lookups and stays pure. Each child is assigned at most once; unmatched
 * children are orphans.
 */
function matchChildren(records: WorkRecord[]): {
  childrenByOrchestratorId: Map<string, WorkRecord[]>;
  orphans: WorkRecord[];
} {
  const orchestrators = records.filter(isConfirmedOrchestrator);
  const subagents = records.filter((record) => record.role === "subagent");

  const childrenByOrchestratorId = new Map<string, WorkRecord[]>();
  for (const orchestrator of orchestrators) {
    childrenByOrchestratorId.set(orchestrator.id, []);
  }

  const orphans: WorkRecord[] = [];

  for (const child of subagents) {
    const childStart = toMs(child.startedAt);
    let best: WorkRecord | undefined;
    let bestStart = Number.NEGATIVE_INFINITY;
    let bestSameProject = false;

    for (const orchestrator of orchestrators) {
      if (orchestrator.pid !== child.parentPid) continue;

      const parentStart = toMs(orchestrator.startedAt);
      const parentEnd = toMs(orchestrator.settledAt);
      if (childStart < parentStart || childStart > parentEnd) continue;

      const sameProject = orchestrator.project === child.project;
      const better = best === undefined || (sameProject && !bestSameProject) || (sameProject === bestSameProject && parentStart > bestStart);
      if (better) {
        best = orchestrator;
        bestStart = parentStart;
        bestSameProject = sameProject;
      }
    }

    if (best) {
      childrenByOrchestratorId.get(best.id)!.push(child);
    } else {
      orphans.push(child);
    }
  }

  return { childrenByOrchestratorId, orphans };
}

function buildTaskView(orchestrator: WorkRecord, subagents: WorkRecord[]): TaskView {
  const parentStart = toMs(orchestrator.startedAt);
  const parentEnd = toMs(orchestrator.settledAt);

  const intervals = [
    { start: parentStart, end: parentEnd },
    ...subagents.map((child) => ({ start: toMs(child.startedAt), end: toMs(child.settledAt) })),
  ];
  const wallMs = unionMs(intervals);

  const endedAtMs = Math.max(parentEnd, ...subagents.map((child) => toMs(child.settledAt)));
  const waitingMs = orchestrator.waitingMs;
  const workMs = wallMs - waitingMs;
  const usage = sumUsage([orchestrator.usage, ...subagents.map((child) => child.usage)]);
  const segments = sumSegments([orchestrator.segments, ...subagents.map((child) => child.segments)]);

  return {
    id: orchestrator.id,
    ...(orchestrator.sessionId !== undefined ? { sessionId: orchestrator.sessionId } : {}),
    ...(orchestrator.client !== undefined ? { client: orchestrator.client } : {}),
    ...(orchestrator.sessionName !== undefined ? { sessionName: orchestrator.sessionName } : {}),
    ...(orchestrator.sessionDir !== undefined ? { sessionDir: orchestrator.sessionDir } : {}),
    ...(orchestrator.clientId !== undefined ? { clientId: orchestrator.clientId } : {}),
    ...(orchestrator.clientName !== undefined ? { clientName: orchestrator.clientName } : {}),
    ...(orchestrator.projectId !== undefined ? { projectId: orchestrator.projectId } : {}),
    ...(orchestrator.projectName !== undefined ? { projectName: orchestrator.projectName } : {}),
    project: orchestrator.project,
    prompt: orchestrator.prompt,
    startedAt: orchestrator.startedAt,
    endedAt: new Date(endedAtMs).toISOString(),
    wallMs,
    waitingMs,
    workMs,
    status: orchestrator.status,
    orchestrator,
    subagents,
    usage,
    segments,
  };
}

/**
 * Build one {@link TaskView} per *confirmed* orchestrator record, sorted by
 * `startedAt`. An orchestrator-role record flagged `roleConfidence:
 * "uncertain"` (ADR 0022) never anchors a task here — see
 * {@link isConfirmedOrchestrator} and {@link uncertainRecords}.
 */
export function buildTasks(records: WorkRecord[]): TaskView[] {
  const orchestrators = records.filter(isConfirmedOrchestrator).sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt));

  const { childrenByOrchestratorId } = matchChildren(records);

  return orchestrators.map((orchestrator) => buildTaskView(orchestrator, childrenByOrchestratorId.get(orchestrator.id) ?? []));
}

/** Subagent records that could not be matched to any orchestrator record. */
export function orphanSubagents(records: WorkRecord[]): WorkRecord[] {
  return matchChildren(records).orphans;
}

/**
 * Orchestrator-role records that could not be positively proven top-level
 * (ADR 0022's "uncertain" state): no recognised child-env-marker matched,
 * but a live tracked ancestor process was found. Never counted as a new
 * task ({@link buildTasks} excludes them) and never synced as one, but
 * never dropped either — surfaced here so `/kankaku doctor` and the report
 * hint (SUBAGENT-REQ-017) can make the gap visible instead of silent.
 */
export function uncertainRecords(records: WorkRecord[]): WorkRecord[] {
  return records.filter((record) => record.role === "orchestrator" && record.roleConfidence === "uncertain");
}

/** One cluster of confirmed-orchestrator records sharing a pid with overlapping `[startedAt, settledAt]` windows — see {@link detectSameProcessOverlaps}. */
export interface SameProcessOverlap {
  pid: number;
  recordIds: string[];
  /** The union (never the sum) of every clustered record's own wall-time window, via `unionMs`. */
  unionedWallMs: number;
}

/**
 * SUBAGENT-REQ-015: flag confirmed-orchestrator records that share an OS
 * pid AND overlap in time — a pattern that should never occur if pi only
 * ever runs one session per process at a time, but is the observable
 * signature an in-process nested session mechanism (if one existed) would
 * leave behind: two independent `WorkTracker` records, same pid, running
 * concurrently. Purely informational (`/kankaku doctor` reads this, see
 * `adapters/kankaku-command.ts`) — it never changes {@link buildTasks}'
 * own per-task `wallMs`, so a plain pi run or today's gentle-pi setup is
 * completely unaffected; each flagged record still anchors its own
 * `TaskView` exactly as before. `unionedWallMs` is provided (via the
 * existing `unionMs` primitive, ADR 0006 — the interval-union rule stays
 * in exactly this one place) so a human reading the doctor report can see
 * what the corrected total would be, without kankaku silently changing any
 * number on its own.
 */
export function detectSameProcessOverlaps(records: WorkRecord[]): SameProcessOverlap[] {
  const orchestratorsByPid = new Map<number, WorkRecord[]>();
  for (const record of records.filter(isConfirmedOrchestrator)) {
    const group = orchestratorsByPid.get(record.pid);
    if (group) {
      group.push(record);
    } else {
      orchestratorsByPid.set(record.pid, [record]);
    }
  }

  const overlaps: SameProcessOverlap[] = [];

  for (const [pid, group] of orchestratorsByPid) {
    if (group.length < 2) continue;

    const intervals = group.map((record) => ({ start: toMs(record.startedAt), end: toMs(record.settledAt) }));
    const anyOverlap = intervals.some((a, i) => intervals.some((b, j) => i !== j && a.start < b.end && b.start < a.end));
    if (!anyOverlap) continue;

    overlaps.push({
      pid,
      recordIds: group.map((record) => record.id),
      unionedWallMs: unionMs(intervals),
    });
  }

  return overlaps;
}

/**
 * Group tasks by `sessionId` (tasks without one fall under `"unknown"`).
 * `wallMs` is the union of every interval — orchestrator and subagent alike
 * — across all of the session's tasks, not a sum of per-task `wallMs`.
 */
export function buildSessions(tasks: TaskView[]): SessionView[] {
  const groups = new Map<string, TaskView[]>();
  for (const task of tasks) {
    const key = task.sessionId ?? "unknown";
    const list = groups.get(key);
    if (list) {
      list.push(task);
    } else {
      groups.set(key, [task]);
    }
  }

  const sessions: SessionView[] = [];

  for (const [sessionId, sessionTasks] of groups) {
    const intervals = sessionTasks.flatMap((task) => [
      { start: toMs(task.orchestrator.startedAt), end: toMs(task.orchestrator.settledAt) },
      ...task.subagents.map((child) => ({ start: toMs(child.startedAt), end: toMs(child.settledAt) })),
    ]);

    const wallMs = unionMs(intervals);
    const waitingMs = sessionTasks.reduce((sum, task) => sum + task.waitingMs, 0);
    const workMs = wallMs - waitingMs;
    const startedAtMs = Math.min(...sessionTasks.map((task) => toMs(task.startedAt)));
    const endedAtMs = Math.max(...sessionTasks.map((task) => toMs(task.endedAt)));
    const usage = sumUsage(sessionTasks.map((task) => task.usage));
    const segments = sumSegments(sessionTasks.map((task) => task.segments));

    sessions.push({
      sessionId,
      project: sessionTasks[0]!.project,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      wallMs,
      waitingMs,
      workMs,
      tasks: sessionTasks,
      usage,
      segments,
    });
  }

  return sessions.sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt));
}
