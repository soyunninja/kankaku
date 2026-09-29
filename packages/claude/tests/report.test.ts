import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, WORK_RECORD_SCHEMA } from "kankaku-pi/domain";
import type { WorkRecord, WorkStatus, UsageTotals } from "kankaku-pi/domain";
import { formatReport, formatDuration } from "../src/report.ts";

let nextId = 0;

function record(opts: {
  startedAt: Date;
  wallMs: number;
  waitingMs: number;
  workMs: number;
  cost?: number;
  status?: WorkStatus;
  prompt?: string;
}): WorkRecord {
  const startedAt = opts.startedAt;
  const settledAt = new Date(startedAt.getTime() + opts.wallMs);
  const usage: UsageTotals = { ...emptyUsage(), cost: opts.cost ?? 0 };
  nextId += 1;
  return {
    schema: WORK_RECORD_SCHEMA,
    id: `id-${nextId}`,
    prompt: opts.prompt ?? "prompt",
    startedAt: startedAt.toISOString(),
    settledAt: settledAt.toISOString(),
    wallMs: opts.wallMs,
    waitingMs: opts.waitingMs,
    workMs: opts.workMs,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage,
    status: opts.status ?? "completed",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/repo",
  };
}

test("formatDuration formats hours, minutes and seconds per the spec examples", () => {
  assert.equal(formatDuration((3600 + 2 * 60) * 1000), "1h 02m");
  assert.equal(formatDuration(12 * 60 * 1000 + 5 * 1000), "12m 05s");
  assert.equal(formatDuration(8 * 1000), "8s");
});

test("formatReport says so when there are no tasks in the window", () => {
  const output = formatReport([], { now: Date.now() });
  assert.equal(output, "No tasks recorded in the last 7 days.\n");
});

test("formatReport groups tasks by local day, with a short-prompt task's full line", () => {
  const now = new Date(2026, 8, 24, 18, 0, 0);
  const startedAt = new Date(2026, 8, 24, 14, 15, 0);
  const records = [
    record({
      startedAt,
      wallMs: 3720_000, // 1h 02m
      waitingMs: 600_000, // 10m 00s
      workMs: 3_120_000, // 52m 00s
      cost: 0,
      status: "interrupted",
      prompt: "short prompt",
    }),
  ];

  const output = formatReport(records, { now: now.getTime() });
  const hh = String(startedAt.getHours()).padStart(2, "0");
  const mm = String(startedAt.getMinutes()).padStart(2, "0");
  assert.equal(
    output,
    [
      "2026-09-24",
      `  ${hh}:${mm}  interrupted  wall 1h 02m  wait 10m 00s  work 52m 00s  -  short prompt`,
      "  total: 1 task  wall 1h 02m  wait 10m 00s  work 52m 00s  $0.00",
      "",
      "Grand total: 1 task  wall 1h 02m  wait 10m 00s  work 52m 00s  $0.00",
    ].join("\n") + "\n",
  );
});

test("formatReport groups two tasks on the same day under one heading and totals them", () => {
  const now = new Date(2026, 8, 24, 18, 0, 0);
  const records = [
    record({
      startedAt: new Date(2026, 8, 24, 9, 30, 0),
      wallMs: 125_000,
      waitingMs: 5_000,
      workMs: 120_000,
      cost: 1.5,
      status: "completed",
      prompt: "short one",
    }),
    record({
      startedAt: new Date(2026, 8, 24, 14, 15, 0),
      wallMs: 3_720_000,
      waitingMs: 600_000,
      workMs: 3_120_000,
      cost: 0,
      status: "interrupted",
      prompt: "short two",
    }),
  ];

  const output = formatReport(records, { now: now.getTime() });
  const dayLines = output.split("\n");
  assert.equal(dayLines[0], "2026-09-24");
  assert.equal(dayLines.filter((l) => l === "2026-09-24").length, 1);
  assert.ok(output.includes("wall 2m 05s  wait 5s  work 2m 00s  $1.50  short one"));
  assert.ok(output.includes("wall 1h 02m  wait 10m 00s  work 52m 00s  -  short two"));
  assert.ok(output.includes("total: 2 tasks  wall"));
  assert.ok(output.includes("Grand total: 2 tasks  wall"));
});

test("formatReport puts tasks from different days under separate headings, sorted", () => {
  const now = new Date(2026, 8, 24, 18, 0, 0);
  const records = [
    record({ startedAt: new Date(2026, 8, 23, 10, 0, 0), wallMs: 1000, waitingMs: 0, workMs: 1000, prompt: "yesterday" }),
    record({ startedAt: new Date(2026, 8, 24, 10, 0, 0), wallMs: 1000, waitingMs: 0, workMs: 1000, prompt: "today" }),
  ];

  const output = formatReport(records, { now: now.getTime() });
  const indexYesterday = output.indexOf("2026-09-23");
  const indexToday = output.indexOf("2026-09-24");
  assert.ok(indexYesterday >= 0 && indexToday >= 0);
  assert.ok(indexYesterday < indexToday);
});

test("formatReport excludes tasks outside the day window", () => {
  const now = new Date(2026, 8, 24, 18, 0, 0);
  const records = [
    record({ startedAt: new Date(2026, 8, 14, 10, 0, 0), wallMs: 1000, waitingMs: 0, workMs: 1000, prompt: "too old" }),
  ];

  const output = formatReport(records, { now: now.getTime(), days: 7 });
  assert.equal(output, "No tasks recorded in the last 7 days.\n");
});

test("formatReport respects a custom days option", () => {
  const now = new Date(2026, 8, 24, 18, 0, 0);
  const records = [
    record({ startedAt: new Date(2026, 8, 22, 10, 0, 0), wallMs: 1000, waitingMs: 0, workMs: 1000, prompt: "two days ago" }),
  ];

  assert.equal(formatReport(records, { now: now.getTime(), days: 1 }), "No tasks recorded in the last 1 days.\n");
  assert.ok(formatReport(records, { now: now.getTime(), days: 3 }).includes("two days ago"));
});

test("formatReport truncates a long prompt to 60 characters (including ellipsis) and collapses newlines to a single line", () => {
  const longPrompt = Array.from({ length: 8 }, () => "0123456789").join(""); // 80 chars
  const now = new Date(2026, 8, 24, 18, 0, 0);
  const records = [
    record({ startedAt: new Date(2026, 8, 24, 10, 0, 0), wallMs: 1000, waitingMs: 0, workMs: 1000, prompt: longPrompt }),
  ];
  const output = formatReport(records, { now: now.getTime() });
  assert.equal(output.includes(longPrompt), false);
  assert.ok(output.includes(`${longPrompt.slice(0, 59)}…`));

  const multilinePrompt = "line one\nline two\nline three";
  const records2 = [
    record({ startedAt: new Date(2026, 8, 24, 10, 0, 0), wallMs: 1000, waitingMs: 0, workMs: 1000, prompt: multilinePrompt }),
  ];
  const output2 = formatReport(records2, { now: now.getTime() });
  const promptLine = output2.split("\n").find((l) => l.includes("line one"));
  assert.ok(promptLine);
  assert.equal(promptLine?.includes("\n"), false);
  assert.ok(promptLine?.includes("line one line two line three"));
});
