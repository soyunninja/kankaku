import assert from "node:assert/strict";
import { test } from "node:test";
import { findAncestorEntry } from "../src/domain/ancestry-match.ts";
import type { RegistryEntry } from "../src/ports/process-registry.ts";

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid: 100,
    parentPid: 1,
    role: "orchestrator",
    project: "/proj",
    dir: "/proj/.kankaku",
    startedAt: "2026-09-10T16:00:00.000Z",
    ...overrides,
  };
}

test("findAncestorEntry returns undefined when there are no ancestor pids or no entries", () => {
  assert.equal(findAncestorEntry([], [entry()]), undefined);
  assert.equal(findAncestorEntry([100], []), undefined);
});

test("findAncestorEntry finds the immediate parent when it is tracked", () => {
  const parent = entry({ pid: 50 });
  assert.equal(findAncestorEntry([50, 40, 30], [parent]), parent);
});

test("findAncestorEntry walks past an untracked hop (e.g. a shell wrapper) to find a further tracked ancestor (SUBAGENT-REQ-011)", () => {
  const grandparent = entry({ pid: 30 });
  // pid 50 and 40 are ancestors with no registry entry of their own.
  assert.equal(findAncestorEntry([50, 40, 30], [grandparent]), grandparent);
});

test("findAncestorEntry prefers the nearest tracked ancestor over a further one", () => {
  const near = entry({ pid: 40 });
  const far = entry({ pid: 30 });
  assert.equal(findAncestorEntry([50, 40, 30], [far, near]), near);
});

test("findAncestorEntry returns undefined when no ancestor pid is tracked", () => {
  const unrelated = entry({ pid: 999 });
  assert.equal(findAncestorEntry([50, 40, 30], [unrelated]), undefined);
});
