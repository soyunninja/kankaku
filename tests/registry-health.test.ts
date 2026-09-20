import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRegistryEntries, DEFAULT_MAX_ENTRY_AGE_MS } from "../src/domain/registry-health.ts";
import type { RegistryEntry } from "../src/ports/process-registry.ts";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid: 100,
    parentPid: 1,
    role: "orchestrator",
    project: "/proj",
    dir: "/proj/.kankaku",
    startedAt: "2026-09-20T11:00:00.000Z",
    processStartId: 1000,
    ...overrides,
  };
}

function deps(overrides: Partial<Parameters<typeof classifyRegistryEntries>[2]> = {}) {
  return {
    isAlive: () => true,
    liveStartId: () => undefined as number | undefined,
    now: NOW,
    maxAgeMs: DEFAULT_MAX_ENTRY_AGE_MS,
    ...overrides,
  };
}

test("keeps a live, identity-verified entry", () => {
  const live = entry({ pid: 200, processStartId: 1000 });
  const result = classifyRegistryEntries([live], 999, deps({ isAlive: () => true, liveStartId: (pid) => (pid === 200 ? 1000 : undefined) }));
  assert.deepEqual(result.keep, [live]);
  assert.deepEqual(result.discard, []);
});

test("discards a dead-pid entry as 'dead'", () => {
  const dead = entry({ pid: 200 });
  const result = classifyRegistryEntries([dead], 999, deps({ isAlive: () => false }));
  assert.deepEqual(result.keep, []);
  assert.deepEqual(result.discard, [{ entry: dead, reason: "dead" }]);
});

test("never discards the caller's own just-written entry, regardless of isAlive/liveStartId", () => {
  const own = entry({ pid: 999 });
  const result = classifyRegistryEntries([own], 999, deps({ isAlive: () => false, liveStartId: () => undefined }));
  assert.deepEqual(result.keep, [own]);
  assert.deepEqual(result.discard, []);
});

test("discards an alive-pid entry whose recorded identity no longer matches the live process (stale-by-reuse)", () => {
  const reused = entry({ pid: 200, processStartId: 1000 });
  const result = classifyRegistryEntries([reused], 999, deps({ isAlive: () => true, liveStartId: (pid) => (pid === 200 ? 999_999 : undefined) }));
  assert.deepEqual(result.discard, [{ entry: reused, reason: "stale-reuse" }]);
});

test("discards a legacy entry with no processStartId as unverifiable, even when the pid is alive", () => {
  const legacy = entry({ pid: 200 });
  delete (legacy as { processStartId?: number }).processStartId;
  const result = classifyRegistryEntries([legacy], 999, deps({ isAlive: () => true }));
  assert.deepEqual(result.discard, [{ entry: legacy, reason: "unverifiable-identity" }]);
});

test("keeps an alive entry when liveStartId is unknown for that pid (fails safe, no stale-reuse verdict without evidence)", () => {
  const unverified = entry({ pid: 200, processStartId: 1000 });
  const result = classifyRegistryEntries([unverified], 999, deps({ isAlive: () => true, liveStartId: () => undefined }));
  assert.deepEqual(result.keep, [unverified]);
});

test("discards an over-age entry as a last resort, even when it is alive and identity-verified", () => {
  const old = entry({ pid: 200, processStartId: 1000, startedAt: new Date(NOW - DEFAULT_MAX_ENTRY_AGE_MS - 1000).toISOString() });
  const result = classifyRegistryEntries([old], 999, deps({ isAlive: () => true, liveStartId: (pid) => (pid === 200 ? 1000 : undefined) }));
  assert.deepEqual(result.discard, [{ entry: old, reason: "over-age" }]);
});

test("keeps an entry just under the max age", () => {
  const fresh = entry({ pid: 200, processStartId: 1000, startedAt: new Date(NOW - DEFAULT_MAX_ENTRY_AGE_MS + 1000).toISOString() });
  const result = classifyRegistryEntries([fresh], 999, deps({ isAlive: () => true, liveStartId: (pid) => (pid === 200 ? 1000 : undefined) }));
  assert.deepEqual(result.keep, [fresh]);
});

test("classifies several entries independently in one pass", () => {
  const alive = entry({ pid: 1, processStartId: 10 });
  const dead = entry({ pid: 2, processStartId: 20 });
  const stale = entry({ pid: 3, processStartId: 30 });
  const result = classifyRegistryEntries(
    [alive, dead, stale],
    999,
    deps({
      isAlive: (pid) => pid !== 2,
      liveStartId: (pid) => (pid === 1 ? 10 : pid === 3 ? 30_000 : undefined),
    }),
  );
  assert.deepEqual(result.keep, [alive]);
  assert.deepEqual(
    result.discard.map((d) => d.entry.pid),
    [2, 3],
  );
});
