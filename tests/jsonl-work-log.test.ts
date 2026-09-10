import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { JsonlWorkLog } from "../src/adapters/jsonl-work-log.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kankaku-test-"));
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec-1",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/tmp/project",
    prompt: "hello",
    startedAt: "2026-09-10T16:00:00.000Z",
    settledAt: "2026-09-10T16:00:01.000Z",
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

test("append creates the target directory and writes one JSON line", () => {
  const logDir = join(dir, ".kankaku");
  const log = new JsonlWorkLog(logDir);

  log.append(makeRecord());

  const file = join(logDir, "worklog.jsonl");
  assert.ok(existsSync(file));
  const records = log.readAll();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, "rec-1");
});

test("append writes one line per record, in order", () => {
  const log = new JsonlWorkLog(dir);

  log.append(makeRecord({ id: "rec-1" }));
  log.append(makeRecord({ id: "rec-2" }));
  log.append(makeRecord({ id: "rec-3" }));

  const records = log.readAll();
  assert.deepEqual(
    records.map((r) => r.id),
    ["rec-1", "rec-2", "rec-3"],
  );
});

test("readAll returns an empty array when the log file does not exist", () => {
  const log = new JsonlWorkLog(join(dir, "does-not-exist"));

  assert.deepEqual(log.readAll(), []);
});

test("readAll skips malformed lines", () => {
  const logDir = join(dir, ".kankaku");
  const log = new JsonlWorkLog(logDir);
  log.append(makeRecord({ id: "rec-1" }));

  const file = join(logDir, "worklog.jsonl");
  writeFileSync(file, "not json at all\n", { flag: "a" });
  log.append(makeRecord({ id: "rec-2" }));

  const records = log.readAll();
  assert.deepEqual(
    records.map((r) => r.id),
    ["rec-1", "rec-2"],
  );
});
