import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkRecord } from "kankaku-pi/domain";
import { buildTodayRows, formatTodayLines } from "../src/domain/today-model.ts";

const DAY = "2026-09-27";

function record(overrides: Partial<WorkRecord> & Record<string, unknown> = {}): WorkRecord {
  return {
    schema: 1,
    id: overrides.id ?? "rec-1",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "demo",
    prompt: "hello",
    startedAt: `${DAY}T09:00:00.000Z`,
    settledAt: `${DAY}T09:01:00.000Z`,
    wallMs: 60000,
    waitingMs: 5000,
    workMs: 55000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 100, output: 0, cacheRead: 300, cacheWrite: 0, cost: 1.5 },
    status: "completed",
    ...overrides,
  } as WorkRecord;
}

test("buildTodayRows aggregates one row per project via kankaku's summarize, dropping zero-task days", () => {
  const projects = [
    { name: "alpha", records: [record({ id: "a1" })] },
    {
      name: "beta",
      records: [
        record({
          id: "b1",
          settledAt: `${DAY}T09:02:00.000Z`,
          waitingMs: 10000,
          usage: { input: 100, output: 0, cacheRead: 100, cacheWrite: 0, cost: 3 },
        }),
      ],
    },
    { name: "gamma", records: [] },
  ];

  const { rows, total } = buildTodayRows(projects, { today: DAY });

  assert.deepEqual(
    rows.map((r) => r.name),
    ["beta", "alpha"],
  );

  const alpha = rows.find((r) => r.name === "alpha")!;
  assert.equal(alpha.tasks, 1);
  assert.equal(alpha.wallMs, 60000);
  assert.equal(alpha.workMs, 55000);
  assert.equal(alpha.waitingMs, 5000);
  assert.equal(alpha.cost, 1.5);
  assert.equal(alpha.cacheHit, 0.75);

  assert.equal(total.tasks, 2);
  assert.equal(total.wallMs, 180000);
  assert.equal(total.workMs, 165000);
  assert.equal(total.waitingMs, 15000);
  assert.equal(total.cost, 4.5);
  // 400 cacheRead / (200 input + 400 cacheRead) = 0.6666...
  assert.ok(Math.abs(total.cacheHit! - 400 / 600) < 1e-9);
});

test("buildTodayRows omits a project with no tasks on the target day", () => {
  const projects = [{ name: "solo", records: [record()] }];
  const { rows } = buildTodayRows(projects, { today: "2020-01-01" });
  assert.deepEqual(rows, []);
});

test("buildTodayRows sorts rows by workMs descending", () => {
  const projects = [
    { name: "small", records: [record({ id: "s1", settledAt: `${DAY}T09:00:01.000Z`, waitingMs: 0 })] },
    { name: "big", records: [record({ id: "b1", settledAt: `${DAY}T09:01:30.000Z`, waitingMs: 0 })] },
  ];
  const { rows } = buildTodayRows(projects, { today: DAY });
  assert.deepEqual(
    rows.map((r) => r.name),
    ["big", "small"],
  );
});

test("formatTodayLines renders one aligned line per row plus a total line", () => {
  const rows = [{ name: "alpha", tasks: 2, wallMs: 3720000, workMs: 3480000, waitingMs: 240000, cost: 1.234, cacheHit: 0.71 }];
  const total = { name: "total", tasks: 2, wallMs: 3720000, workMs: 3480000, waitingMs: 240000, cost: 1.234, cacheHit: 0.71 };

  const lines = formatTodayLines(rows, total);

  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^alpha\s+tasks 2\s+wall 1h02m\s+work 58m\s+wait 4m\s+\$1\.23\s+cache hit 71%$/);
  assert.match(lines[1]!, /^total\s+tasks 2\s+wall 1h02m\s+work 58m\s+wait 4m\s+\$1\.23\s+cache hit 71%$/);
});

test("formatTodayLines omits the cache hit segment when it is undefined", () => {
  const rows = [{ name: "alpha", tasks: 1, wallMs: 60000, workMs: 60000, waitingMs: 0, cost: 0 }];
  const total = { name: "total", tasks: 1, wallMs: 60000, workMs: 60000, waitingMs: 0, cost: 0 };
  const lines = formatTodayLines(rows, total);
  assert.equal(lines[0], "alpha  tasks 1  wall 1m  work 1m  wait 0m  $0.00");
});
