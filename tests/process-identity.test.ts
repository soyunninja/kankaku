import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProcessIdentity } from "../src/adapters/process-identity.ts";
import type { RegistryEntry } from "../src/ports/process-registry.ts";
import type { ProcessRegistry } from "../src/ports/process-registry.ts";
import type { AncestrySnapshot } from "../src/adapters/ancestry.ts";
import { BUILTIN_SUBAGENT_PROFILES, buildConfiguredProfile } from "../src/domain/subagent-profile.ts";

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

test("SUBAGENT-REQ-005/017: identity.profile is undefined by default (no subagentProfiles supplied) — the pre-6b default, only GENTLE_PI_AGENTS_CHILD is recognised", () => {
  const identity = resolveProcessIdentity(baseDeps({ env: { GENTLE_PI_AGENTS_CHILD: "1" } }));
  assert.equal(identity.role, "subagent");
  assert.equal(identity.profile, "gentle-pi");
});

test("SUBAGENT-REQ-005/017: with the full built-in profile set, PI_SUBAGENT_DEPTH alone confirms role=subagent and identity.profile='pi-subagents'", () => {
  const identity = resolveProcessIdentity(baseDeps({ env: { PI_SUBAGENT_DEPTH: "1" }, subagentProfiles: BUILTIN_SUBAGENT_PROFILES }));
  assert.equal(identity.role, "subagent");
  assert.equal(identity.childMarkerPresent, true);
  assert.equal(identity.profile, "pi-subagents");
});

test("PI_SUBAGENT_DEPTH is NOT recognised when subagentProfiles is not supplied (the pre-6b default stays exactly GENTLE_PI_AGENTS_CHILD-only — no regression for a caller that has not opted into the wider profile set)", () => {
  const identity = resolveProcessIdentity(baseDeps({ env: { PI_SUBAGENT_DEPTH: "1" } }));
  assert.equal(identity.role, "orchestrator");
  assert.equal(identity.childMarkerPresent, false);
  assert.equal(identity.profile, undefined);
});

test("identity.profile stays undefined when no known marker is present (ancestry-only, e.g. pi's bundled reference example)", () => {
  const identity = resolveProcessIdentity(baseDeps({ env: {}, subagentProfiles: BUILTIN_SUBAGENT_PROFILES }));
  assert.equal(identity.profile, undefined);
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

// --- C2 (CRITICAL fix): a configured marker never demotes an interactive
// session, and `profile` is only ever attributed when role actually ended
// up "subagent" — a configured marker present-but-ignored must never
// leave an orchestrator record carrying `profile: "configured"`. ---

test("C2: a configured marker confirms subagent for a NON-interactive process, with profile attribution", () => {
  const configured = buildConfiguredProfile([], [{ name: "MY_CHILD", value: "1" }])!;
  const identity = resolveProcessIdentity(
    baseDeps({ env: { MY_CHILD: "1" }, isInteractiveGuess: false, subagentProfiles: [...BUILTIN_SUBAGENT_PROFILES, configured] }),
  );

  assert.equal(identity.role, "subagent");
  assert.equal(identity.profile, "configured");
  assert.equal(identity.configuredMarkerIgnoredInteractive, undefined);
});

test("C2: a configured marker is ignored for an INTERACTIVE process — role stays orchestrator, profile is undefined (never a contradictory orchestrator-with-profile record), and configuredMarkerIgnoredInteractive is surfaced", () => {
  const configured = buildConfiguredProfile([], [{ name: "MY_CHILD", value: "1" }])!;
  const identity = resolveProcessIdentity(
    baseDeps({ env: { MY_CHILD: "1" }, isInteractiveGuess: true, subagentProfiles: [...BUILTIN_SUBAGENT_PROFILES, configured] }),
  );

  assert.equal(identity.role, "orchestrator");
  assert.equal(identity.profile, undefined);
  assert.equal(identity.configuredMarkerIgnoredInteractive, true);
  // The built-in "confirmed child marker" signal stays false — it never
  // matched here, only the (ignored) configured one did.
  assert.equal(identity.childMarkerPresent, false);
});

test("C2: a BUILT-IN marker (GENTLE_PI_AGENTS_CHILD) still wins outright, even interactively, when a configured profile is ALSO active", () => {
  const configured = buildConfiguredProfile([], [{ name: "MY_CHILD", value: "1" }])!;
  const identity = resolveProcessIdentity(
    baseDeps({ env: { GENTLE_PI_AGENTS_CHILD: "1" }, isInteractiveGuess: true, subagentProfiles: [...BUILTIN_SUBAGENT_PROFILES, configured] }),
  );

  assert.equal(identity.role, "subagent");
  assert.equal(identity.profile, "gentle-pi");
  assert.equal(identity.childMarkerPresent, true);
  assert.equal(identity.configuredMarkerIgnoredInteractive, undefined);
});

test("C2: no configured profile active at all — configuredMarkerIgnoredInteractive stays undefined regardless of interactivity", () => {
  const identity = resolveProcessIdentity(baseDeps({ env: {}, isInteractiveGuess: true, subagentProfiles: BUILTIN_SUBAGENT_PROFILES }));
  assert.equal(identity.configuredMarkerIgnoredInteractive, undefined);
});
