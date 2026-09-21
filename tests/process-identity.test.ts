import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProcessIdentity } from "../src/adapters/process-identity.ts";
import type { RegistryEntry } from "../src/ports/process-registry.ts";
import type { ProcessRegistry } from "../src/ports/process-registry.ts";
import type { AncestrySnapshot } from "../src/adapters/ancestry.ts";

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid: 50,
    parentPid: 1,
    role: "orchestrator",
    project: "/proj",
    dir: "/proj/.kankaku",
    startedAt: "2026-09-10T16:00:00.000Z",
    processStartId: 1_757_000_000_000,
    ...overrides,
  };
}

function fakeRegistry(entries: RegistryEntry[]): ProcessRegistry {
  return {
    record: () => {},
    readAll: () => entries,
  };
}

const NOW = 1_757_000_010_000;
function baseDeps(overrides: Partial<Parameters<typeof resolveProcessIdentity>[0]> = {}): Parameters<typeof resolveProcessIdentity>[0] {
  return {
    env: {},
    registry: fakeRegistry([]),
    ppid: 999,
    now: () => NOW,
    uptimeSeconds: () => 10,
    isInteractiveGuess: false,
    ...overrides,
  };
}

test("no marker, no override, no tracked ancestor: a confirmed orchestrator with no orchestratorRef", () => {
  const identity = resolveProcessIdentity(baseDeps());
  assert.equal(identity.role, "orchestrator");
  assert.equal(identity.orchestratorRef, undefined);
  assert.equal(identity.hasTrackedAncestor, false);
  assert.equal(identity.childMarkerPresent, false);
  assert.equal(identity.roleOverride, undefined);
  assert.equal(identity.overrideIgnoredInteractive, undefined);
  assert.equal(typeof identity.ownProcessStartId, "number");
});

test("GENTLE_PI_AGENTS_CHILD=1 with a verified tracked ancestor: subagent, with orchestratorRef resolved from the ancestor", () => {
  const parent = entry({ pid: 50 });
  const env = { GENTLE_PI_AGENTS_CHILD: "1" };
  const snapshotAncestry = (): AncestrySnapshot => ({
    ppidByPid: new Map([[999, 50]]),
    startIdByPid: new Map([[50, parent.processStartId!]]),
  });

  const identity = resolveProcessIdentity(baseDeps({ env, registry: fakeRegistry([parent]), snapshotAncestry }));

  assert.equal(identity.role, "subagent");
  assert.equal(identity.childMarkerPresent, true);
  assert.equal(identity.hasTrackedAncestor, true);
  assert.deepEqual(identity.orchestratorRef, { pid: 50, project: "/proj", startedAt: "2026-09-10T16:00:00.000Z", dir: "/proj/.kankaku" });
});

test("KANKAKU_ROLE is read then stripped from env in place (R1, layer 2)", () => {
  const env: NodeJS.ProcessEnv = { KANKAKU_ROLE: "orchestrator" };
  const identity = resolveProcessIdentity(baseDeps({ env }));

  assert.equal(identity.roleOverride, "orchestrator");
  assert.equal(identity.role, "orchestrator");
  assert.equal(env["KANKAKU_ROLE"], undefined, "the override must be stripped from the real env object passed in, so no spawned child inherits it");
});

test("a confirmed child marker always wins over a leaked KANKAKU_ROLE=orchestrator (R1)", () => {
  const env: NodeJS.ProcessEnv = { KANKAKU_ROLE: "orchestrator", GENTLE_PI_AGENTS_CHILD: "1" };
  const identity = resolveProcessIdentity(baseDeps({ env }));

  assert.equal(identity.role, "subagent");
  assert.equal(identity.roleOverride, "orchestrator", "roleOverride still reports what was actually read, even though the marker won");
});

test("KANKAKU_ROLE=subagent in an interactive session with no confirmed marker is ignored, and overrideIgnoredInteractive is surfaced", () => {
  const env: NodeJS.ProcessEnv = { KANKAKU_ROLE: "subagent" };
  const identity = resolveProcessIdentity(baseDeps({ env, isInteractiveGuess: true }));

  assert.equal(identity.role, "orchestrator");
  assert.equal(identity.overrideIgnoredInteractive, true);
});

test("role=orchestrator never resolves an orchestratorRef, even when a tracked ancestor exists (orchestratorRef only ever applies to a subagent)", () => {
  const parent = entry({ pid: 50 });
  const snapshotAncestry = (): AncestrySnapshot => ({
    ppidByPid: new Map([[999, 50]]),
    startIdByPid: new Map([[50, parent.processStartId!]]),
  });

  const identity = resolveProcessIdentity(baseDeps({ registry: fakeRegistry([parent]), snapshotAncestry }));

  assert.equal(identity.role, "orchestrator");
  assert.equal(identity.orchestratorRef, undefined);
  // hasTrackedAncestor is still reported truthfully even for an orchestrator
  // — it is what `resolveRoleConfidence` later needs, at session_start.
  assert.equal(identity.hasTrackedAncestor, true);
});

test("liveStartId is threaded through from resolveSubagentStartup for the registry's own sweep", () => {
  const parent = entry({ pid: 50 });
  const snapshotAncestry = (): AncestrySnapshot => ({
    ppidByPid: new Map([[999, 50]]),
    startIdByPid: new Map([[50, parent.processStartId!]]),
  });

  const identity = resolveProcessIdentity(baseDeps({ registry: fakeRegistry([parent]), snapshotAncestry }));

  assert.equal(identity.liveStartId(50), parent.processStartId);
  assert.equal(identity.liveStartId(12345), undefined);
});
