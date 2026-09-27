import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTasksModel } from "../src/domain/tasks-model.ts";
import type { WorkRecord } from "kankaku/domain";

function record(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "r1",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "demo",
    prompt: "a very long prompt that should be truncated to about forty columns for the row",
    startedAt: "2026-09-27T09:00:00.000Z",
    settledAt: "2026-09-27T09:01:00.000Z",
    wallMs: 60000,
    waitingMs: 0,
    workMs: 60000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1.5 },
    status: "completed",
    ...overrides,
  } as WorkRecord;
}

interface ProjectInput {
  name: string;
  records: WorkRecord[];
}

test("buildTasksModel returns one row per task, newest first, restricted to today by default", () => {
  const projects: ProjectInput[] = [
    {
      name: "alpha",
      records: [
        record({ id: "old", startedAt: "2020-01-01T09:00:00.000Z", settledAt: "2020-01-01T09:01:00.000Z" }),
        record({ id: "new", startedAt: "2026-09-27T10:00:00.000Z", settledAt: "2026-09-27T10:01:00.000Z" }),
      ],
    },
  ];

  const model = buildTasksModel(projects, { all: false, today: "2026-09-27" });

  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0]?.id, "new");
});

test("buildTasksModel with all:true includes every task across projects, newest first", () => {
  const projects: ProjectInput[] = [
    { name: "alpha", records: [record({ id: "a1", startedAt: "2026-09-27T09:00:00.000Z" })] },
    { name: "beta", records: [record({ id: "b1", startedAt: "2026-09-27T10:00:00.000Z" })] },
  ];

  const model = buildTasksModel(projects, { all: true });

  assert.deepEqual(
    model.rows.map((row) => row.id),
    ["b1", "a1"],
  );
});

test("buildTasksModel row carries project name, client/hub names, wall/work/cost, and a truncated prompt", () => {
  const projects: ProjectInput[] = [
    {
      name: "alpha",
      records: [
        record({
          id: "r1",
          clientName: "Acme",
          projectName: "Website",
          hubTaskTitle: "Fix the checkout flow",
        } as Partial<WorkRecord>),
      ],
    },
  ];

  const model = buildTasksModel(projects, { all: true });
  const row = model.rows[0]!;

  assert.equal(row.project, "alpha");
  assert.equal(row.clientName, "Acme");
  assert.equal(row.projectName, "Website");
  assert.equal(row.hubTaskTitle, "Fix the checkout flow");
  assert.equal(row.wallMs, 60000);
  assert.equal(row.workMs, 60000);
  assert.equal(row.cost, 1.5);
  assert.ok(row.prompt.length <= 40);
  assert.match(row.prompt, /…$/);
});

test("buildTasksModel formats time as HH:MM local", () => {
  const projects: ProjectInput[] = [{ name: "alpha", records: [record({ id: "r1", startedAt: "2026-09-27T09:05:00.000Z" })] }];
  const model = buildTasksModel(projects, { all: true });
  assert.match(model.rows[0]!.time, /^\d{2}:\d{2}$/);
});
