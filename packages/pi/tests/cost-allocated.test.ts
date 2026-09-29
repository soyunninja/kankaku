import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlWorkLog } from "../src/adapters/jsonl-work-log.ts";
import { buildTaskEntryCreatePayload, buildTaskEntryUpdatePayload, buildWorkRecordPayload } from "../src/domain/hub-entry.ts";
import type { HubEntryContext } from "../src/domain/hub-entry.ts";
import { computeTaskContentHash } from "../src/domain/sync-plan.ts";
import type { TaskView } from "../src/domain/task-view.ts";
import { isWorkRecord } from "../src/domain/work-record.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec-1",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/proj",
    prompt: "prompt",
    startedAt: "2026-09-10T16:00:00.000Z",
    settledAt: "2026-09-10T16:00:10.000Z",
    wallMs: 10000,
    waitingMs: 0,
    workMs: 10000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
    status: "completed",
    costObserved: true,
    ...overrides,
  };
}

function taskOf(orchestrator: WorkRecord): TaskView {
  return {
    id: orchestrator.id,
    project: orchestrator.project,
    prompt: orchestrator.prompt,
    startedAt: orchestrator.startedAt,
    endedAt: orchestrator.settledAt,
    wallMs: orchestrator.wallMs,
    waitingMs: orchestrator.waitingMs,
    workMs: orchestrator.workMs,
    status: orchestrator.status,
    orchestrator,
    subagents: [],
    usage: orchestrator.usage,
    segments: {},
  };
}

const ctx: HubEntryContext = {
  clients: [],
  projects: [],
  tasks: [],
  machine: "machine",
  promptMode: "full",
  agent: "claude-code",
  plugin: "kankaku-claude",
};

test("a record marked costAllocated is a valid record and survives the worklog round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-allocated-"));
  try {
    const record = makeRecord({ costAllocated: true });
    assert.equal(isWorkRecord(record), true);
    const log = new JsonlWorkLog(dir);
    log.append(record);
    const [read] = log.readAll();
    assert.equal(read?.costAllocated, true);
    assert.equal(read?.usage.cost, 0.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("costAllocated never reaches a hub payload", () => {
  const task = taskOf(makeRecord({ costAllocated: true }));
  const payloads = [
    buildTaskEntryCreatePayload(task, ctx),
    buildTaskEntryUpdatePayload(task, ctx),
    buildWorkRecordPayload(task.orchestrator, "entry-1", ctx),
  ];
  for (const payload of payloads) {
    assert.doesNotMatch(JSON.stringify(payload), /allocated/i);
  }
});

test("costAllocated does not change the content hash of a task", () => {
  const plain = taskOf(makeRecord());
  const allocated = taskOf(makeRecord({ costAllocated: true }));
  assert.equal(computeTaskContentHash(allocated), computeTaskContentHash(plain));
});
