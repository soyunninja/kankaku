import assert from "node:assert/strict";
import { test } from "node:test";
import { findAncestorEntry, START_ID_TOLERANCE_MS } from "../src/domain/ancestry-match.ts";
import type { RegistryEntry } from "../src/ports/process-registry.ts";

const BASE_START_ID = 1_757_000_000_000;

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid: 100,
    parentPid: 1,
    role: "orchestrator",
    project: "/proj",
    dir: "/proj/.kankaku",
    startedAt: "2026-09-10T16:00:00.000Z",
    processStartId: BASE_START_ID,
    ...overrides,
  };
}

/** A `liveStartId` lookup that agrees exactly with every entry's own `processStartId` — the "genuinely still the same process" case. */
function agreeingLiveStartId(entries: RegistryEntry[]): (pid: number) => number | undefined {
  const byPid = new Map(entries.map((candidate) => [candidate.pid, candidate.processStartId]));
  return (pid) => byPid.get(pid);
}

test("findAncestorEntry returns undefined when there are no ancestor pids or no entries", () => {
  assert.equal(
    findAncestorEntry([], [entry()], () => BASE_START_ID),
    undefined,
  );
  assert.equal(
    findAncestorEntry([100], [], () => BASE_START_ID),
    undefined,
  );
});

test("findAncestorEntry finds the immediate parent when it is tracked and its start identity matches", () => {
  const parent = entry({ pid: 50 });
  assert.equal(findAncestorEntry([50, 40, 30], [parent], agreeingLiveStartId([parent])), parent);
});

test("findAncestorEntry walks past an untracked hop (e.g. a shell wrapper) to find a further tracked ancestor (SUBAGENT-REQ-011)", () => {
  const grandparent = entry({ pid: 30 });
  // pid 50 and 40 are ancestors with no registry entry of their own.
  assert.equal(findAncestorEntry([50, 40, 30], [grandparent], agreeingLiveStartId([grandparent])), grandparent);
});

test("findAncestorEntry prefers the nearest tracked ancestor over a further one", () => {
  const near = entry({ pid: 40 });
  const far = entry({ pid: 30 });
  assert.equal(findAncestorEntry([50, 40, 30], [far, near], agreeingLiveStartId([far, near])), near);
});

test("findAncestorEntry returns undefined when no ancestor pid is tracked", () => {
  const unrelated = entry({ pid: 999 });
  assert.equal(findAncestorEntry([50, 40, 30], [unrelated], agreeingLiveStartId([unrelated])), undefined);
});

test("a stale entry left behind by a dead process, now reused by an unrelated live process, is never matched (the PID-reuse blocker)", () => {
  const stale = entry({ pid: 50, processStartId: BASE_START_ID });
  // The live process now holding pid 50 started at a very different time.
  const reusedLiveStartId = (pid: number) => (pid === 50 ? BASE_START_ID + 10 * 60 * 60 * 1000 : undefined);
  assert.equal(findAncestorEntry([50], [stale], reusedLiveStartId), undefined);
});

test("a stale-by-reuse near ancestor is skipped in favour of a genuine further tracked ancestor", () => {
  const staleNear = entry({ pid: 40, processStartId: BASE_START_ID });
  const genuineFar = entry({ pid: 30, processStartId: BASE_START_ID + 5000 });
  const liveStartId = (pid: number) => {
    if (pid === 40) return BASE_START_ID + 999_999; // reused, far outside tolerance
    if (pid === 30) return BASE_START_ID + 5000; // still the same process
    return undefined;
  };
  assert.equal(findAncestorEntry([50, 40, 30], [staleNear, genuineFar], liveStartId), genuineFar);
});

test("a genuinely live tracked parent still matches (unchanged happy path)", () => {
  const parent = entry({ pid: 50, processStartId: BASE_START_ID });
  assert.equal(findAncestorEntry([50], [parent], (pid) => (pid === 50 ? BASE_START_ID : undefined)), parent);
});

test("start id within tolerance still matches (second-granularity rounding noise)", () => {
  const parent = entry({ pid: 50, processStartId: BASE_START_ID });
  const live = (pid: number) => (pid === 50 ? BASE_START_ID + START_ID_TOLERANCE_MS : undefined);
  assert.equal(findAncestorEntry([50], [parent], live), parent);
});

test("start id just outside tolerance does not match", () => {
  const parent = entry({ pid: 50, processStartId: BASE_START_ID });
  const live = (pid: number) => (pid === 50 ? BASE_START_ID + START_ID_TOLERANCE_MS + 1 : undefined);
  assert.equal(findAncestorEntry([50], [parent], live), undefined);
});

test("an entry with no processStartId (legacy/malformed) is never trusted, even when the pid is genuinely still tracked", () => {
  const legacy = entry({ pid: 50 });
  delete (legacy as { processStartId?: number }).processStartId;
  assert.equal(
    findAncestorEntry([50], [legacy], () => BASE_START_ID),
    undefined,
  );
});

test("an unavailable live start identity (this process could not read its own ancestry start times) never matches, even against a well-formed entry", () => {
  const parent = entry({ pid: 50, processStartId: BASE_START_ID });
  assert.equal(
    findAncestorEntry([50], [parent], () => undefined),
    undefined,
  );
});
