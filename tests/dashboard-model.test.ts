import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkRecord } from "kankaku/domain";
import { buildDashboardModel } from "../src/domain/dashboard-model.ts";

const TODAY = "2026-09-27";

function record(day: string, overrides: Partial<WorkRecord> & Record<string, unknown> = {}): WorkRecord {
  return {
    schema: 1,
    id: overrides.id ?? "rec-1",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "demo",
    prompt: "hello",
    startedAt: `${day}T09:00:00.000Z`,
    settledAt: `${day}T09:01:00.000Z`,
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

test("today card mirrors the total row for the target day", () => {
  const projects = [
    { name: "alpha", records: [record(TODAY, { id: "a1" })] },
    { name: "beta", records: [record(TODAY, { id: "b1", usage: { input: 100, output: 0, cacheRead: 100, cacheWrite: 0, cost: 3 } })] },
  ];
  const model = buildDashboardModel(projects, undefined, undefined, { today: TODAY });
  assert.equal(model.today.tasks, 2);
  assert.equal(model.today.cost, 4.5);
  assert.equal(model.today.workMs, 110000);
});

test("project rows carry a share relative to the busiest project", () => {
  // task.workMs is derived from `settledAt - startedAt` (minus `waitingMs`),
  // not from the record's own `workMs`/`wallMs` fields (see `task-view.ts`),
  // so the fixtures below control duration through timestamps.
  const projects = [
    {
      name: "alpha",
      records: [record(TODAY, { id: "a1", waitingMs: 0, settledAt: `${TODAY}T09:01:40.000Z` })], // 100000ms wall
    },
    {
      name: "beta",
      records: [record(TODAY, { id: "b1", waitingMs: 0, settledAt: `${TODAY}T09:00:50.000Z` })], // 50000ms wall
    },
  ];
  const model = buildDashboardModel(projects, undefined, undefined, { today: TODAY });
  const alpha = model.projects.find((p) => p.name === "alpha")!;
  const beta = model.projects.find((p) => p.name === "beta")!;
  assert.equal(alpha.share, 1);
  assert.equal(beta.share, 0.5);
});

test("last7Days has exactly 7 points ending on the target day, oldest first", () => {
  const projects = [{ name: "alpha", records: [record(TODAY, { id: "a1" })] }];
  const model = buildDashboardModel(projects, undefined, undefined, { today: TODAY });
  assert.equal(model.last7Days.length, 7);
  assert.equal(model.last7Days[6]!.day, TODAY);
  assert.equal(model.last7Days[0]!.day, "2026-09-21");
  assert.ok(model.last7Days.every((point) => typeof point.weekday === "string" && point.weekday.length === 3));
});

test("last7Days sums work and cost across every project for each day", () => {
  const yesterday = "2026-09-26";
  const projects = [
    {
      name: "alpha",
      records: [
        record(yesterday, {
          id: "a1",
          waitingMs: 0,
          settledAt: `${yesterday}T09:01:00.000Z`, // 60000ms wall
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 2 },
        }),
      ],
    },
    {
      name: "beta",
      records: [
        record(yesterday, {
          id: "b1",
          waitingMs: 0,
          settledAt: `${yesterday}T09:00:30.000Z`, // 30000ms wall
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 },
        }),
      ],
    },
  ];
  const model = buildDashboardModel(projects, undefined, undefined, { today: TODAY });
  const point = model.last7Days.find((p) => p.day === yesterday)!;
  assert.equal(point.workMs, 90000);
  assert.equal(point.cost, 3);
});

test("hub card is unavailable without sync entries", () => {
  const model = buildDashboardModel([], undefined, undefined, { today: TODAY });
  assert.deepEqual(model.hub, { status: "unavailable" });
});

test("hub card aggregates pending/stale across projects and carries the last sync time and catalog summary", () => {
  const model = buildDashboardModel(
    [],
    [
      { name: "alpha", status: { state: { syncedThrough: "2026-09-27T08:00:00.000Z", hashes: {}, target: "https://hub.example.com" }, pending: 2, staleOutsideWindow: 0 } },
      { name: "beta", status: { state: { syncedThrough: "2026-09-27T08:20:00.000Z", hashes: {}, target: "https://hub.example.com" }, pending: 1, staleOutsideWindow: 1 } },
    ],
    { url: "https://hub.example.com", clientCount: 9, projectCount: 17 },
    { today: TODAY },
  );
  assert.deepEqual(model.hub, {
    status: "ready",
    pending: 3,
    staleOutsideWindow: 1,
    lastSyncOk: true,
    lastSyncAt: "2026-09-27T08:20:00.000Z",
    catalog: { url: "https://hub.example.com", clientCount: 9, projectCount: 17 },
  });
});

test("hub card reports lastSyncOk false when any project carries a sync error", () => {
  const model = buildDashboardModel(
    [],
    [{ name: "alpha", status: { state: { syncedThrough: "2026-09-27T08:00:00.000Z", hashes: {}, target: "https://hub.example.com", lastError: { message: "boom", at: "2026-09-27T08:00:00.000Z" } }, pending: 0, staleOutsideWindow: 0 } }],
    undefined,
    { today: TODAY },
  );
  assert.equal(model.hub.status === "ready" && model.hub.lastSyncOk, false);
});
