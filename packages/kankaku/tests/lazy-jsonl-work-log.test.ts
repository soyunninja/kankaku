import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LazyJsonlWorkLog } from "../src/adapters/lazy-jsonl-work-log.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

function makeRecord(project: string, id: string): WorkRecord {
  return {
    schema: 1,
    id,
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project,
    sessionId: "s",
    sessionFile: undefined,
    mode: "tui",
    prompt: "p",
    startedAt: "2026-09-10T10:00:00.000Z",
    settledAt: "2026-09-10T10:00:01.000Z",
    wallMs: 1000,
    waitingMs: 0,
    workMs: 1000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    status: "completed",
  };
}

test("readAll before any append reads the log from the fallback cwd", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kankaku-lazy-"));
  mkdirSync(join(cwd, ".kankaku"));
  writeFileSync(join(cwd, ".kankaku", "worklog.jsonl"), `${JSON.stringify(makeRecord(cwd, "existing"))}\n`);

  const log = new LazyJsonlWorkLog(".kankaku", () => cwd);

  assert.deepEqual(
    log.readAll().map((record) => record.id),
    ["existing"],
  );
});

test("append resolves the directory against the record project and later reads include it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kankaku-lazy-"));
  const log = new LazyJsonlWorkLog(".kankaku", () => "/should/not/be/used");

  log.append(makeRecord(cwd, "first"));

  assert.ok(readFileSync(join(cwd, ".kankaku", "worklog.jsonl"), "utf8").includes('"first"'));
  assert.deepEqual(
    log.readAll().map((record) => record.id),
    ["first"],
  );
});

test("version delegates to the resolved log, resolving against the fallback cwd when nothing was appended yet", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kankaku-lazy-"));
  const log = new LazyJsonlWorkLog(".kankaku", () => cwd);

  const before = log.version();
  log.append(makeRecord(cwd, "first"));
  const after = log.version();

  assert.notEqual(after, before);
});

test("an absolute directory is used as-is", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "kankaku-lazy-")), "abs-log");
  const log = new LazyJsonlWorkLog(dir, () => "/ignored");

  log.append(makeRecord("/some/project", "abs"));

  assert.ok(readFileSync(join(dir, "worklog.jsonl"), "utf8").includes('"abs"'));
});
