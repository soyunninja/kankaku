import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { MachineProcessRegistry } from "../src/adapters/machine-process-registry.ts";
import { resolveSubagentStartup } from "../src/adapters/subagent-startup.ts";
import { resolveOrchestratorRef } from "../src/domain/ancestry-match.ts";
import { resolveWritableTarget } from "../src/adapters/kankaku-dir.ts";
import { JsonlWorkLog } from "../src/adapters/jsonl-work-log.ts";
import { buildTasks } from "../src/domain/task-view.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";
import type { AncestrySnapshot } from "../src/adapters/ancestry.ts";

/**
 * F1 (BLOCKER): an integration-level reproduction of the real ordering an
 * independent review proved for gentle-pi's main case — a blocking
 * `subagent_run` in task mode — using the REAL adapters end to end (a real
 * `MachineProcessRegistry` against real temp directories, real
 * `JsonlWorkLog` files, the real `resolveSubagentStartup` /
 * `resolveOrchestratorRef` / `resolveWritableTarget` composition, and the
 * real `buildTasks`), with only the OS ancestor-chain SNAPSHOT itself
 * injected (two real, unrelated pids on this one test process cannot
 * actually be ancestor/descendant of each other — that real-process
 * ordering is proven separately, with a genuine `spawnSync` parent/child,
 * by `scripts/e2e-cross-worktree-real-processes.ts`, kept out of `npm
 * test`). Everything downstream of "here is an ancestry snapshot" is 100%
 * real, not a shortcut.
 *
 * The exact ordering under test: the child registers, resolves its
 * orchestrator's directory, WRITES ITS OWN RECORD, then removes its own
 * registry entry (exit cleanup) — and only THEN does the parent build its
 * task list. Before this fix, the parent could only discover a
 * cross-worktree child through a still-live registry pointer at read time;
 * this reproduces that the child is found (joined) even though the pointer
 * is already gone by the time the parent looks — because the record was
 * never anywhere else to begin with.
 */

let runDir: string;
let homeDir: string;
let worktreeA: string;
let worktreeB: string;

const PARENT_PID = 100;
const CHILD_PID = 200;
const PARENT_START_ID = 1_757_000_000_000;
const CHILD_START_ID = 1_757_000_005_000;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "kankaku-cross-worktree-routing-"));
  homeDir = join(runDir, "home");
  worktreeA = join(runDir, "worktree-a");
  worktreeB = join(runDir, "worktree-b");
});

after(() => {
  if (runDir) rmSync(runDir, { recursive: true, force: true });
});

function iso(msFromEpoch: number): string {
  return new Date(msFromEpoch).toISOString();
}

function makeRecord(overrides: Partial<WorkRecord> & Pick<WorkRecord, "id" | "pid" | "parentPid" | "role" | "project">): WorkRecord {
  return {
    schema: 1,
    prompt: "cross-worktree routing test",
    startedAt: iso(0),
    settledAt: iso(1000),
    wallMs: 1000,
    waitingMs: 0,
    workMs: 1000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    status: "completed",
    ...overrides,
  };
}

/** A fake ancestry snapshot: the child's ppid resolves to the parent, with matching identity. */
function childAncestrySnapshot(): AncestrySnapshot {
  return {
    ppidByPid: new Map([[CHILD_PID, PARENT_PID]]),
    startIdByPid: new Map([[PARENT_PID, PARENT_START_ID]]),
  };
}

test("F1: the child's record joins the parent's task even though the child's registry entry is gone by the time the parent builds tasks (real adapters, real fs, injected ancestry snapshot only)", () => {
  const registry = new MachineProcessRegistry(() => homeDir);

  // --- Parent registers first, as extension.ts would at startup. ---
  registry.record(
    { pid: PARENT_PID, parentPid: 1, role: "orchestrator", project: worktreeA, dir: worktreeA, startedAt: iso(0), processStartId: PARENT_START_ID },
    () => true,
  );

  // --- Child startup: resolves its orchestrator via the registry, using
  // the real resolveSubagentStartup composition (only the OS snapshot is
  // injected). ---
  const childStartup = resolveSubagentStartup({
    registry,
    ppid: PARENT_PID, // the child's real OS ppid is the parent's pid
    now: () => 0,
    uptimeSeconds: () => 0,
    snapshotAncestry: childAncestrySnapshot,
  });
  assert.equal(childStartup.ancestorEntry?.pid, PARENT_PID, "the child must discover the parent as its verified ancestor");

  const childOrchestratorRef = resolveOrchestratorRef(childStartup.ancestorEntry);
  assert.equal(childOrchestratorRef?.dir, worktreeA, "the resolved orchestratorRef must carry the parent's real dir");

  registry.record(
    {
      pid: CHILD_PID,
      parentPid: PARENT_PID,
      role: "subagent",
      project: worktreeB,
      dir: worktreeB,
      startedAt: iso(5000),
      orchestratorRef: childOrchestratorRef,
      processStartId: CHILD_START_ID,
    },
    () => true,
  );

  // --- F1: the child routes its OWN write into the parent's directory
  // (real resolveWritableTarget + real JsonlWorkLog — no shortcut). ---
  const routed = resolveWritableTarget(childOrchestratorRef!.dir!, worktreeB);
  assert.deepEqual(routed, { dir: worktreeA, usedFallback: false }, "the child must route into the real, writable parent directory");

  const childLog = new JsonlWorkLog(routed.dir);
  childLog.append(
    makeRecord({
      id: "child-task",
      role: "subagent",
      pid: CHILD_PID,
      parentPid: PARENT_PID,
      project: worktreeB,
      orchestratorRef: childOrchestratorRef,
      startedAt: iso(5000),
      settledAt: iso(15000),
    }),
  );

  // --- The child exits: removes its OWN registry entry (real exit cleanup). ---
  registry.removeOwn(CHILD_PID, CHILD_START_ID);
  assert.equal(
    registry.readAll().some((entry) => entry.pid === CHILD_PID),
    false,
    "the child's registry entry must actually be gone before the parent looks",
  );

  // --- The parent appends its OWN record locally (as it always has) and
  // THEN builds its task list — the registry pointer is already gone. ---
  const parentLog = new JsonlWorkLog(worktreeA);
  parentLog.append(
    makeRecord({
      id: "parent-task",
      role: "orchestrator",
      pid: PARENT_PID,
      parentPid: 1,
      project: worktreeA,
      startedAt: iso(0),
      settledAt: iso(10000),
    }),
  );

  const tasks = buildTasks(parentLog.readAll());
  assert.equal(tasks.length, 1, "exactly one task, never two, never split");
  assert.equal(tasks[0]?.id, "parent-task");
  assert.equal(tasks[0]?.subagents.length, 1, "the child must be joined, despite its registry entry being gone");
  assert.equal(tasks[0]?.subagents[0]?.id, "child-task");
  assert.equal(tasks[0]?.wallMs, 15000, "union of [0,10] and [5,15] (relative seconds) = 15s");
});

test("F1 regression: a second buildTasks pass, run after the child's registry entry is gone, does not shrink wall_ms/cost/subagent_count", () => {
  const registry = new MachineProcessRegistry(() => homeDir);
  registry.record(
    { pid: PARENT_PID, parentPid: 1, role: "orchestrator", project: worktreeA, dir: worktreeA, startedAt: iso(0), processStartId: PARENT_START_ID },
    () => true,
  );

  const childStartup = resolveSubagentStartup({
    registry,
    ppid: PARENT_PID,
    now: () => 0,
    uptimeSeconds: () => 0,
    snapshotAncestry: childAncestrySnapshot,
  });
  const childOrchestratorRef = resolveOrchestratorRef(childStartup.ancestorEntry)!;
  registry.record(
    { pid: CHILD_PID, parentPid: PARENT_PID, role: "subagent", project: worktreeB, dir: worktreeB, startedAt: iso(5000), orchestratorRef: childOrchestratorRef, processStartId: CHILD_START_ID },
    () => true,
  );

  const routed = resolveWritableTarget(childOrchestratorRef.dir!, worktreeB);
  new JsonlWorkLog(routed.dir).append(
    makeRecord({
      id: "child-task",
      role: "subagent",
      pid: CHILD_PID,
      parentPid: PARENT_PID,
      project: worktreeB,
      orchestratorRef: childOrchestratorRef,
      startedAt: iso(5000),
      settledAt: iso(15000),
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    }),
  );
  registry.removeOwn(CHILD_PID, CHILD_START_ID);

  const parentLog = new JsonlWorkLog(worktreeA);
  parentLog.append(
    makeRecord({
      id: "parent-task",
      role: "orchestrator",
      pid: PARENT_PID,
      parentPid: 1,
      project: worktreeA,
      startedAt: iso(0),
      settledAt: iso(10000),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
    }),
  );

  // Sync pass #1.
  const firstPass = buildTasks(parentLog.readAll())[0]!;
  assert.equal(firstPass.wallMs, 15000);
  assert.equal(firstPass.subagents.length, 1);
  assert.ok(Math.abs(firstPass.usage.cost - 0.03) < 1e-9);

  // Sync pass #2, well after the child's registry entry was removed —
  // nothing about reading the log again should ever produce a smaller
  // result, since the record's location never depended on that pointer.
  const secondPass = buildTasks(parentLog.readAll())[0]!;
  assert.equal(secondPass.wallMs, firstPass.wallMs, "wall_ms must never shrink on a later pass");
  assert.equal(secondPass.subagents.length, firstPass.subagents.length, "subagent_count must never shrink on a later pass");
  assert.ok(Math.abs(secondPass.usage.cost - firstPass.usage.cost) < 1e-9, "cost must never shrink on a later pass");
});
