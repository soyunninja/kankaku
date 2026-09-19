import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { FileInflightStore } from "../src/adapters/file-inflight-store.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kankaku-inflight-"));
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

test("save writes a checkpoint file for this process's pid, and clear removes it", () => {
  const store = new FileInflightStore(dir, 1234);
  store.save(makeRecord({ id: "r1", pid: 1234 }));

  const file = join(dir, "inflight", "1234.json");
  assert.ok(existsSync(file));

  store.clear();
  assert.equal(existsSync(file), false);
});

test("clear on a store with no saved checkpoint does not throw", () => {
  const store = new FileInflightStore(dir, 4321);
  assert.doesNotThrow(() => store.clear());
});

test("recoverStale returns and removes a checkpoint whose pid is dead, marked interrupted", () => {
  const reader = new FileInflightStore(dir, 999);
  const dead = new FileInflightStore(dir, 555);
  dead.save(makeRecord({ id: "dead-1", pid: 555, status: "completed", settledAt: "2026-09-10T16:00:05.000Z" }));

  const recovered = reader.recoverStale(() => false);

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.id, "dead-1");
  assert.equal(recovered[0]?.status, "interrupted");
  assert.equal(recovered[0]?.settledAt, "2026-09-10T16:00:05.000Z");
  assert.equal(existsSync(join(dir, "inflight", "555.json")), false);
});

test("recoverStale leaves a checkpoint whose pid is alive untouched", () => {
  const reader = new FileInflightStore(dir, 999);
  const alive = new FileInflightStore(dir, 556);
  alive.save(makeRecord({ id: "alive-1", pid: 556 }));

  const recovered = reader.recoverStale(() => true);

  assert.equal(recovered.length, 0);
  assert.ok(existsSync(join(dir, "inflight", "556.json")));
});

test("recoverStale deletes and ignores a malformed checkpoint file", () => {
  const reader = new FileInflightStore(dir, 999);
  mkdirSync(join(dir, "inflight"), { recursive: true });
  writeFileSync(join(dir, "inflight", "777.json"), "not json");

  const recovered = reader.recoverStale(() => false);

  assert.equal(recovered.length, 0);
  assert.equal(existsSync(join(dir, "inflight", "777.json")), false);
});

test("recoverStale skips this process's own checkpoint file", () => {
  const store = new FileInflightStore(dir, 999);
  store.save(makeRecord({ id: "own-1", pid: 999 }));

  const recovered = store.recoverStale(() => false);

  assert.equal(recovered.length, 0);
  assert.ok(existsSync(join(dir, "inflight", "999.json")));
});

test("recoverStale returns an empty array when the inflight directory does not exist", () => {
  const reader = new FileInflightStore(join(dir, "does-not-exist"), 999);
  assert.deepEqual(reader.recoverStale(() => false), []);
});

test("recoverStale deletes a stray .tmp file whose writer pid is dead", () => {
  mkdirSync(join(dir, "inflight"), { recursive: true });
  const tmpFile = join(dir, "inflight", "42.json.8888.1700000000000.tmp");
  writeFileSync(tmpFile, "{}");

  const reader = new FileInflightStore(dir, 999);
  const recovered = reader.recoverStale(() => false);

  assert.equal(recovered.length, 0);
  assert.equal(existsSync(tmpFile), false);
});

test("recoverStale leaves a stray .tmp file whose writer pid is alive", () => {
  mkdirSync(join(dir, "inflight"), { recursive: true });
  const tmpFile = join(dir, "inflight", "42.json.8888.1700000000000.tmp");
  writeFileSync(tmpFile, "{}");

  const reader = new FileInflightStore(dir, 999);
  const recovered = reader.recoverStale(() => true);

  assert.equal(recovered.length, 0);
  assert.ok(existsSync(tmpFile));
});

test("recoverStale never deletes a .tmp file written by the current process, even if isAlive claims it is dead", () => {
  mkdirSync(join(dir, "inflight"), { recursive: true });
  const tmpFile = join(dir, "inflight", `42.json.${process.pid}.1700000000000.tmp`);
  writeFileSync(tmpFile, "{}");

  const reader = new FileInflightStore(dir, 999);
  const recovered = reader.recoverStale(() => false);

  assert.equal(recovered.length, 0);
  assert.ok(existsSync(tmpFile));
});

test("recoverStale deletes a .tmp file whose writer pid cannot be parsed", () => {
  mkdirSync(join(dir, "inflight"), { recursive: true });
  const tmpFile = join(dir, "inflight", "garbage.tmp");
  writeFileSync(tmpFile, "{}");

  const reader = new FileInflightStore(dir, 999);
  const recovered = reader.recoverStale(() => false);

  assert.equal(recovered.length, 0);
  assert.equal(existsSync(tmpFile), false);
});
