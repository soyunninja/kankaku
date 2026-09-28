import assert from "node:assert/strict";
import { test } from "node:test";
import { createProcessIdentityMemo } from "../src/adapters/process-identity-memo.ts";
import type { ResolveProcessIdentityDeps } from "../src/adapters/process-identity.ts";
import type { RegistryEntry } from "../src/ports/process-registry.ts";
import type { ProcessRegistry } from "../src/ports/process-registry.ts";

function fakeRegistry(entries: RegistryEntry[]): ProcessRegistry {
  return {
    record: () => {},
    readAll: () => entries,
  };
}

function baseDeps(overrides: Partial<ResolveProcessIdentityDeps> = {}): ResolveProcessIdentityDeps {
  return {
    env: {},
    registry: fakeRegistry([]),
    ppid: 999,
    now: () => 1_757_000_010_000,
    uptimeSeconds: () => 10,
    isInteractiveGuess: false,
    ...overrides,
  };
}

test("G1: resolve() computes once and reuses the exact same object on every later call, even with completely different deps", () => {
  const memo = createProcessIdentityMemo();

  const first = memo.resolve(baseDeps({ env: { KANKAKU_ROLE: "orchestrator" } }));
  // A wildly different `deps` (as if this were a genuinely different
  // invocation reading a since-mutated env) must be ignored entirely.
  const second = memo.resolve(baseDeps({ env: { GENTLE_PI_AGENTS_CHILD: "1" } }));

  assert.strictEqual(first, second, "the second call must return the IDENTICAL object, not merely an equal one");
  assert.equal(second.role, "orchestrator", "the frozen facts from the FIRST call must win, never the second call's inputs");
});

test("G1 (the core bug): a forced KANKAKU_ROLE=orchestrator survives a second same-process resolve() even after the first call already stripped it from env", () => {
  const memo = createProcessIdentityMemo();
  const env: NodeJS.ProcessEnv = { KANKAKU_ROLE: "orchestrator" };

  const first = memo.resolve(baseDeps({ env }));
  assert.equal(first.roleOverride, "orchestrator");
  assert.equal(env["KANKAKU_ROLE"], undefined, "stripped from the real env after the first call, exactly like a real pi re-invocation would see");

  // Simulate pi re-invoking the extension factory in the same process:
  // a fresh call, with the now-stripped env (roleOverride would read
  // undefined if resolveProcessIdentity ran again).
  const second = memo.resolve(baseDeps({ env }));

  assert.equal(second.roleOverride, "orchestrator", "the override must still be reported, from the frozen first-call facts");
  assert.equal(second.role, "orchestrator");
});

test("G1: identical role, confidence-affecting facts, and write-routing target across two consecutive resolve() calls, with different registry/ancestry inputs each time", () => {
  const parent: RegistryEntry = {
    pid: 50,
    parentPid: 1,
    role: "orchestrator",
    project: "/proj",
    dir: "/proj/.kankaku",
    startedAt: "2026-09-10T16:00:00.000Z",
    processStartId: 1_757_000_000_000,
  };
  const memo = createProcessIdentityMemo();
  const env: NodeJS.ProcessEnv = { GENTLE_PI_AGENTS_CHILD: "1" };

  const deps1: ResolveProcessIdentityDeps = {
    env,
    registry: fakeRegistry([parent]),
    ppid: 999,
    now: () => 1_757_000_010_000,
    uptimeSeconds: () => 10,
    isInteractiveGuess: false,
    snapshotAncestry: () => ({ ppidByPid: new Map([[999, 50]]), startIdByPid: new Map([[50, parent.processStartId!]]) }),
  };
  const first = memo.resolve(deps1);

  // Second invocation: a completely empty registry this time (as if the
  // parent's own entry had meanwhile been swept) — must be irrelevant.
  const deps2: ResolveProcessIdentityDeps = {
    ...deps1,
    registry: fakeRegistry([]),
    snapshotAncestry: () => ({ ppidByPid: new Map(), startIdByPid: new Map() }),
  };
  const second = memo.resolve(deps2);

  assert.deepEqual(second.orchestratorRef, first.orchestratorRef);
  assert.equal(second.role, first.role);
  assert.equal(second.hasTrackedAncestor, first.hasTrackedAncestor);
  assert.equal(second.ownProcessStartId, first.ownProcessStartId);
});

test("registerExitCleanupOnce registers the listener exactly once across several calls (no listener pile-up across /new//resume/fork/reload)", () => {
  const memo = createProcessIdentityMemo();
  const registered: Array<() => void> = [];
  const on = (listener: () => void): void => {
    registered.push(listener);
  };

  let cleanupCalls = 0;
  memo.registerExitCleanupOnce(on, () => {
    cleanupCalls++;
  });
  memo.registerExitCleanupOnce(on, () => {
    cleanupCalls++;
  });
  memo.registerExitCleanupOnce(on, () => {
    cleanupCalls++;
  });

  assert.equal(registered.length, 1, "only the FIRST call may actually register a listener");
  registered[0]!();
  assert.equal(cleanupCalls, 1, "and it must be the first call's own cleanup that ran");
});

test("two independent memo instances never share frozen facts (a fresh memo per OS process, never global module state read directly)", () => {
  const memoA = createProcessIdentityMemo();
  const memoB = createProcessIdentityMemo();

  const a = memoA.resolve(baseDeps({ env: { KANKAKU_ROLE: "orchestrator" } }));
  const b = memoB.resolve(baseDeps({ env: { GENTLE_PI_AGENTS_CHILD: "1" } }));

  assert.equal(a.role, "orchestrator");
  assert.equal(b.role, "subagent");
});
