import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LazyFileInflightStore } from "../src/adapters/lazy-file-inflight-store.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

function makeRecord(project: string, id: string, pid: number): WorkRecord {
  return {
    schema: 1,
    id,
    role: "orchestrator",
    pid,
    parentPid: 0,
    project,
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

test("save resolves the directory against the record project", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kankaku-lazy-inflight-"));
  const store = new LazyFileInflightStore(".kankaku", 42, () => "/should/not/be/used");

  store.save(makeRecord(cwd, "first", 42));

  const file = join(cwd, ".kankaku", "inflight", "42.json");
  assert.ok(existsSync(file));
  assert.ok(readFileSync(file, "utf8").includes('"first"'));
});

test("recoverStale before any save resolves from the fallback cwd", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kankaku-lazy-inflight-"));
  mkdirSync(join(cwd, ".kankaku", "inflight"), { recursive: true });
  writeFileSync(join(cwd, ".kankaku", "inflight", "55.json"), JSON.stringify(makeRecord(cwd, "stale", 55)));

  const store = new LazyFileInflightStore(".kankaku", 42, () => cwd);

  const recovered = store.recoverStale(() => false);
  assert.deepEqual(
    recovered.map((r) => r.id),
    ["stale"],
  );
});

test("clear before any save resolves from the fallback cwd", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kankaku-lazy-inflight-"));
  mkdirSync(join(cwd, ".kankaku", "inflight"), { recursive: true });
  writeFileSync(join(cwd, ".kankaku", "inflight", "42.json"), JSON.stringify(makeRecord(cwd, "own", 42)));

  const store = new LazyFileInflightStore(".kankaku", 42, () => cwd);
  store.clear();

  assert.equal(existsSync(join(cwd, ".kankaku", "inflight", "42.json")), false);
});

test("an absolute directory is used as-is", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "kankaku-lazy-inflight-")), "abs-inflight");
  const store = new LazyFileInflightStore(dir, 42, () => "/ignored");

  store.save(makeRecord("/some/project", "abs", 42));

  assert.ok(readFileSync(join(dir, "inflight", "42.json"), "utf8").includes('"abs"'));
});
