import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { SyncStateStore } from "../src/adapters/sync-state-store.ts";
import type { SyncState } from "../src/domain/sync-plan.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kankaku-sync-state-"));
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const sampleState: SyncState = { target: "https://pb.example.com", syncedThrough: "2026-09-20T00:00:00.000Z", hashes: { a: "hash-a" } };

test("read returns undefined when no state file exists yet", () => {
  const store = new SyncStateStore({ dir, pid: 1 });
  assert.equal(store.read(), undefined);
});

test("write then read round-trips the state", () => {
  const store = new SyncStateStore({ dir, pid: 1 });
  store.write(sampleState);
  assert.deepEqual(store.read(), sampleState);
});

test("read tolerates malformed JSON and returns undefined", () => {
  writeFileSync(join(dir, "sync-state.json"), "{not json");
  const store = new SyncStateStore({ dir, pid: 1 });
  assert.equal(store.read(), undefined);
});

test("read tolerates a structurally invalid document and returns undefined", () => {
  writeFileSync(join(dir, "sync-state.json"), JSON.stringify({ nope: true }));
  const store = new SyncStateStore({ dir, pid: 1 });
  assert.equal(store.read(), undefined);
});

test("write creates the directory when it does not exist yet", () => {
  const nested = join(dir, "nested", "kankaku");
  const store = new SyncStateStore({ dir: nested, pid: 1 });
  store.write(sampleState);
  assert.deepEqual(store.read(), sampleState);
});

test("tryLock succeeds when no lock file exists", () => {
  const store = new SyncStateStore({ dir, pid: 100 });
  assert.equal(store.tryLock(), true);
});

test("tryLock fails while a live, fresh lock is held by another process", () => {
  const holder = new SyncStateStore({ dir, pid: 100, isAlive: () => true });
  assert.equal(holder.tryLock(), true);

  const other = new SyncStateStore({ dir, pid: 200, isAlive: () => true });
  assert.equal(other.tryLock(), false);
});

test("tryLock succeeds when the existing lock's owner is no longer alive", () => {
  const holder = new SyncStateStore({ dir, pid: 100, isAlive: () => true });
  holder.tryLock();

  const other = new SyncStateStore({ dir, pid: 200, isAlive: () => false });
  assert.equal(other.tryLock(), true);
});

test("tryLock succeeds when the existing lock is older than the stale threshold, even if the pid is technically alive", () => {
  let now = 1_000_000;
  const holder = new SyncStateStore({ dir, pid: 100, isAlive: () => true, now: () => now });
  holder.tryLock();

  now += 6 * 60 * 1000; // 6 minutes later, past the 5-minute staleness window
  const other = new SyncStateStore({ dir, pid: 200, isAlive: () => true, now: () => now });
  assert.equal(other.tryLock(), true);
});

test("unlock only releases a lock this process still owns", () => {
  const holder = new SyncStateStore({ dir, pid: 100, isAlive: () => true });
  holder.tryLock();

  const other = new SyncStateStore({ dir, pid: 200, isAlive: () => true });
  other.unlock(); // no-op: pid 200 never held it
  assert.equal(other.tryLock(), false); // still locked by pid 100

  holder.unlock();
  assert.equal(other.tryLock(), true);
});

test("a process can re-acquire its own lock (re-entrant single-flight guard)", () => {
  const store = new SyncStateStore({ dir, pid: 100, isAlive: () => true });
  assert.equal(store.tryLock(), true);
  assert.equal(store.tryLock(), true);
});
