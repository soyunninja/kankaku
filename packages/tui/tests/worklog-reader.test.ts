import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectRecords } from "../src/adapters/worklog-reader.ts";

function makeProject(): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-tui-project-"));
  mkdirSync(join(dir, ".kankaku"), { recursive: true });
  return { dir };
}

function fixtureRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    id: "rec-1",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "demo",
    prompt: "hello",
    startedAt: "2026-09-27T09:00:00.000Z",
    settledAt: "2026-09-27T09:01:00.000Z",
    wallMs: 60000,
    waitingMs: 0,
    workMs: 60000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    status: "completed",
    ...overrides,
  };
}

test("readProjectRecords reads records written under the project dir", () => {
  const { dir } = makeProject();
  try {
    writeFileSync(join(dir, ".kankaku", "worklog.jsonl"), `${JSON.stringify(fixtureRecord())}\n`);
    const records = readProjectRecords({ name: "demo", dir });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.id, "rec-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectRecords returns an empty array when there is no worklog yet", () => {
  const { dir } = makeProject();
  try {
    const records = readProjectRecords({ name: "demo", dir });
    assert.deepEqual(records, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
