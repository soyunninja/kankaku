import { unionMs } from "./intervals.ts";
import { emptyUsage } from "./work-record.ts";
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
}

function toMs(iso: string): number {
  return Date.parse(iso);
}

function sumUsage(totals: UsageTotals[]): UsageTotals {
  const usage = emptyUsage();
  for (const total of totals) {
    usage.input += total.input;
    usage.output += total.output;
    usage.cacheRead += total.cacheRead;
    usage.cacheWrite += total.cacheWrite;
    usage.cost += total.cost;
  }
  return usage;
}

/**
 * Match every subagent record to the orchestrator record it belongs to: same
 * project, `parentPid === orchestrator.pid`, and the child's `startedAt`
 * falls inside the orchestrator's `[startedAt, settledAt]` window. When
 * several orchestrator records match (a reused pid), the latest-starting one
 * wins. Each child is assigned at most once; unmatched children are orphans.
 */
function matchChildren(records: WorkRecord[]): {
  childrenByOrchestratorId: Map<string, WorkRecord[]>;
  orphans: WorkRecord[];
} {
  const orchestrators = records.filter((record) => record.role === "orchestrator");
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

    for (const orchestrator of orchestrators) {
      if (orchestrator.project !== child.project) continue;
      if (orchestrator.pid !== child.parentPid) continue;

      const parentStart = toMs(orchestrator.startedAt);
      const parentEnd = toMs(orchestrator.settledAt);
      if (childStart < parentStart || childStart > parentEnd) continue;

      if (parentStart > bestStart) {
        bestStart = parentStart;
        best = orchestrator;
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

  return {
    id: orchestrator.id,
    ...(orchestrator.sessionId !== undefined ? { sessionId: orchestrator.sessionId } : {}),
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
  };
}

/** Build one {@link TaskView} per orchestrator record, sorted by `startedAt`. */
export function buildTasks(records: WorkRecord[]): TaskView[] {
  const orchestrators = records
    .filter((record) => record.role === "orchestrator")
    .sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt));

  const { childrenByOrchestratorId } = matchChildren(records);

  return orchestrators.map((orchestrator) => buildTaskView(orchestrator, childrenByOrchestratorId.get(orchestrator.id) ?? []));
}

/** Subagent records that could not be matched to any orchestrator record. */
export function orphanSubagents(records: WorkRecord[]): WorkRecord[] {
  return matchChildren(records).orphans;
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
    });
  }

  return sessions.sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt));
}
