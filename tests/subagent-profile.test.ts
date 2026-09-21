import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILTIN_SUBAGENT_PROFILES,
  GENTLE_PI_PROFILE,
  PI_REFERENCE_PROFILE,
  PI_SUBAGENTS_PROFILE,
  buildConfiguredProfile,
  findAmbiguousToolNames,
  matchToolProfiles,
  profileMarkerMatches,
  readLaunchInfo,
  readResultInfo,
  resolveChildProfile,
  resolveToolProfile,
} from "../src/domain/subagent-profile.ts";
import type { SubagentProfile } from "../src/domain/subagent-profile.ts";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

// --- SUBAGENT-REQ-004: gentle-pi profile preserves today's extractTaskId behaviour ---

test("SUBAGENT-REQ-004: gentle-pi profile reads taskId, agent, status, mode, cwd from result.details.gentleAgents", () => {
  const result = {
    details: { gentleAgents: { taskId: "t1", agent: "reviewer", status: "completed", mode: "task", cwd: "/repo/worktree" } },
  };
  assert.deepEqual(GENTLE_PI_PROFILE.readResult(result), {
    taskId: "t1",
    agent: "reviewer",
    status: "completed",
    mode: "task",
    cwd: "/repo/worktree",
  });
});

test("SUBAGENT-REQ-004: gentle-pi profile returns an empty object for a shapeless result (no details.gentleAgents)", () => {
  assert.deepEqual(GENTLE_PI_PROFILE.readResult({}), {});
  assert.deepEqual(GENTLE_PI_PROFILE.readResult(undefined), {});
  assert.deepEqual(GENTLE_PI_PROFILE.readResult(null), {});
});

test("gentle-pi profile never forwards usage — verified against gentle-pi 3.3.0 source, which never puts usage on subagent_run's result", () => {
  const result = { details: { gentleAgents: { taskId: "t1" } }, usage: { input: 10, output: 5, cost: 0.02 } };
  assert.equal(GENTLE_PI_PROFILE.readResult(result).usage, undefined);
});

test("gentle-pi profile declares subagent_run as its only tool and the confirmed GENTLE_PI_AGENTS_CHILD=1 marker", () => {
  assert.deepEqual(GENTLE_PI_PROFILE.toolNames, ["subagent_run"]);
  assert.deepEqual(GENTLE_PI_PROFILE.childEnvMarkers, [{ name: "GENTLE_PI_AGENTS_CHILD", value: "1" }]);
  assert.equal(GENTLE_PI_PROFILE.joinKeyConfidence, "explicit-id");
});

test("gentle-pi profile reads agent/mode from launch args exactly like today's WorkTracker defaults", () => {
  assert.deepEqual(GENTLE_PI_PROFILE.readLaunchArgs({ agent: "reviewer", mode: "background" }), { agent: "reviewer", mode: "background" });
  assert.deepEqual(GENTLE_PI_PROFILE.readLaunchArgs(undefined), {});
});

// --- pi reference example profile ---

test("pi-reference profile declares tool 'subagent' with NO child-env marker (verified: examples/extensions/subagent/index.ts spawns with no env option)", () => {
  assert.deepEqual(PI_REFERENCE_PROFILE.toolNames, ["subagent"]);
  assert.deepEqual(PI_REFERENCE_PROFILE.childEnvMarkers, []);
  assert.equal(PI_REFERENCE_PROFILE.joinKeyConfidence, "ancestry");
});

test("pi-reference profile forwards a top-level result.usage (pi's documented nested-usage convention)", () => {
  const result = { details: { mode: "single" }, usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.01 } };
  assert.deepEqual(PI_REFERENCE_PROFILE.readResult(result).usage, { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
});

test("pi-reference profile ignores a non-numeric usage field rather than guessing", () => {
  assert.equal(PI_REFERENCE_PROFILE.readResult({ usage: "nonsense" }).usage, undefined);
  assert.equal(PI_REFERENCE_PROFILE.readResult({}).usage, undefined);
});

// --- pi-subagents profile ---

test("pi-subagents profile's confirmed marker is PI_SUBAGENT_DEPTH (verified against installed pi-subagents 0.28.0 source), never the unverified PI_SUBAGENT_PARENT_SESSION", () => {
  assert.deepEqual(PI_SUBAGENTS_PROFILE.toolNames, ["subagent"]);
  assert.deepEqual(PI_SUBAGENTS_PROFILE.childEnvMarkers, [{ name: "PI_SUBAGENT_DEPTH" }]);
  assert.equal(PI_SUBAGENTS_PROFILE.joinKeyConfidence, "ancestry");
});

test("pi-subagents profile deliberately never forwards usage, even when present, to avoid double-counting a child that is also ancestry-joined via its own confirmed marker", () => {
  const result = { usage: { input: 5, output: 5, cost: 0.001 } };
  assert.equal(PI_SUBAGENTS_PROFILE.readResult(result).usage, undefined);
});

test("BUILTIN_SUBAGENT_PROFILES contains exactly gentle-pi, pi-reference and pi-subagents, in that order", () => {
  assert.deepEqual(
    BUILTIN_SUBAGENT_PROFILES.map((p) => p.id),
    ["gentle-pi", "pi-reference", "pi-subagents"],
  );
});

// --- SUBAGENT-REQ-002 / SUBAGENT-REQ-003 (parsing lives in config.ts; this covers the profile object construction) ---

test("SUBAGENT-REQ-001/002/003: buildConfiguredProfile builds a 'configured' profile additive to the built-ins", () => {
  const profile = buildConfiguredProfile(["my_tool"], [{ name: "MY_CHILD", value: "1" }]);
  assert.ok(profile);
  assert.equal(profile!.id, "configured");
  assert.deepEqual(profile!.toolNames, ["my_tool"]);
  assert.deepEqual(profile!.childEnvMarkers, [{ name: "MY_CHILD", value: "1" }]);
});

test("buildConfiguredProfile returns undefined when neither tool names nor markers are configured", () => {
  assert.equal(buildConfiguredProfile([], []), undefined);
});

test("buildConfiguredProfile forwards result.usage generically, like the pi-reference profile", () => {
  const profile = buildConfiguredProfile(["my_tool"], [])!;
  assert.deepEqual(profile.readResult({ usage: { input: 1, cost: 0.5 } }).usage, { input: 1, cost: 0.5 });
});

// --- SUBAGENT-REQ-005: tool-name ambiguity ---

test("SUBAGENT-REQ-005: matchToolProfiles finds every profile registering a given tool name", () => {
  const candidates = matchToolProfiles(BUILTIN_SUBAGENT_PROFILES, "subagent");
  assert.deepEqual(
    candidates.map((p) => p.id),
    ["pi-reference", "pi-subagents"],
  );
});

test("SUBAGENT-REQ-005: resolveToolProfile resolves unambiguously when exactly one profile registers the tool name", () => {
  const resolved = resolveToolProfile(BUILTIN_SUBAGENT_PROFILES, "subagent_run");
  assert.equal(resolved.profile?.id, "gentle-pi");
  assert.equal(resolved.ambiguous, false);
});

test("SUBAGENT-REQ-005: resolveToolProfile never guesses when two profiles share a tool name — profile is undefined, ambiguous is true", () => {
  const resolved = resolveToolProfile(BUILTIN_SUBAGENT_PROFILES, "subagent");
  assert.equal(resolved.profile, undefined);
  assert.equal(resolved.ambiguous, true);
  assert.deepEqual(
    resolved.candidates.map((p) => p.id),
    ["pi-reference", "pi-subagents"],
  );
});

test("resolveToolProfile returns no candidates for an unrecognised tool name", () => {
  const resolved = resolveToolProfile(BUILTIN_SUBAGENT_PROFILES, "bash");
  assert.equal(resolved.profile, undefined);
  assert.equal(resolved.ambiguous, false);
  assert.deepEqual(resolved.candidates, []);
});

test("findAmbiguousToolNames reports the 'subagent' collision among the built-ins", () => {
  const ambiguous = findAmbiguousToolNames(BUILTIN_SUBAGENT_PROFILES);
  assert.deepEqual(ambiguous, [{ toolName: "subagent", profileIds: ["pi-reference", "pi-subagents"] }]);
});

test("findAmbiguousToolNames reports nothing when only the gentle-pi profile is active", () => {
  assert.deepEqual(findAmbiguousToolNames([GENTLE_PI_PROFILE]), []);
});

// --- readLaunchInfo / readResultInfo merging for an ambiguous tool name ---

test("readLaunchInfo merges best-effort across ambiguous candidates, first defined field wins in profile order", () => {
  const fakeA: SubagentProfile = {
    id: "a",
    toolNames: ["subagent"],
    childEnvMarkers: [],
    joinKeyConfidence: "none",
    readLaunchArgs: () => ({ agent: undefined, mode: "task" }),
    readResult: () => ({}),
  };
  const fakeB: SubagentProfile = {
    id: "b",
    toolNames: ["subagent"],
    childEnvMarkers: [],
    joinKeyConfidence: "none",
    readLaunchArgs: () => ({ agent: "researcher", mode: "background" }),
    readResult: () => ({}),
  };
  assert.deepEqual(readLaunchInfo([fakeA, fakeB], {}), { agent: "researcher", mode: "task" });
});

test("readResultInfo merges best-effort across ambiguous candidates and never invents a profile-specific field the winning candidate did not provide", () => {
  const fakeA: SubagentProfile = {
    id: "a",
    toolNames: ["subagent"],
    childEnvMarkers: [],
    joinKeyConfidence: "none",
    readLaunchArgs: () => ({}),
    readResult: () => ({ agent: "researcher" }),
  };
  const fakeB: SubagentProfile = {
    id: "b",
    toolNames: ["subagent"],
    childEnvMarkers: [],
    joinKeyConfidence: "none",
    readLaunchArgs: () => ({}),
    readResult: () => ({ taskId: "t9", agent: "someone-else" }),
  };
  assert.deepEqual(readResultInfo([fakeA, fakeB], {}), { agent: "researcher", taskId: "t9" });
});

// --- child-side marker resolution (env -> confirmed profile) ---

test("SUBAGENT-REQ-005/024: resolveChildProfile confirms gentle-pi from GENTLE_PI_AGENTS_CHILD=1 alone", () => {
  const resolved = resolveChildProfile(BUILTIN_SUBAGENT_PROFILES, env({ GENTLE_PI_AGENTS_CHILD: "1" }));
  assert.equal(resolved.profile?.id, "gentle-pi");
  assert.deepEqual(
    resolved.matchedProfiles.map((p) => p.id),
    ["gentle-pi"],
  );
});

test("resolveChildProfile confirms pi-subagents from PI_SUBAGENT_DEPTH being present, any value", () => {
  const resolved = resolveChildProfile(BUILTIN_SUBAGENT_PROFILES, env({ PI_SUBAGENT_DEPTH: "2" }));
  assert.equal(resolved.profile?.id, "pi-subagents");
});

test("resolveChildProfile finds no confirmed profile when no known marker is present (pi-reference: ancestry-only, matches the F5/README behaviour)", () => {
  const resolved = resolveChildProfile(BUILTIN_SUBAGENT_PROFILES, env({}));
  assert.equal(resolved.profile, undefined);
  assert.deepEqual(resolved.matchedProfiles, []);
});

test("resolveChildProfile never guesses a profile when two markers match at once — role can still be trusted elsewhere, but profile attribution stays undefined", () => {
  const ambiguousA: SubagentProfile = { ...GENTLE_PI_PROFILE, id: "dup-a", childEnvMarkers: [{ name: "SHARED_MARKER", value: "1" }] };
  const ambiguousB: SubagentProfile = { ...GENTLE_PI_PROFILE, id: "dup-b", childEnvMarkers: [{ name: "SHARED_MARKER", value: "1" }] };
  const resolved = resolveChildProfile([ambiguousA, ambiguousB], env({ SHARED_MARKER: "1" }));
  assert.equal(resolved.profile, undefined);
  assert.equal(resolved.matchedProfiles.length, 2);
});

test("profileMarkerMatches: an exact-value marker requires an exact match", () => {
  assert.equal(profileMarkerMatches(GENTLE_PI_PROFILE, env({ GENTLE_PI_AGENTS_CHILD: "1" })), true);
  assert.equal(profileMarkerMatches(GENTLE_PI_PROFILE, env({ GENTLE_PI_AGENTS_CHILD: "0" })), false);
  assert.equal(profileMarkerMatches(GENTLE_PI_PROFILE, env({})), false);
});

test("profileMarkerMatches: a presence-only marker (no configured value) matches any non-empty value", () => {
  assert.equal(profileMarkerMatches(PI_SUBAGENTS_PROFILE, env({ PI_SUBAGENT_DEPTH: "1" })), true);
  assert.equal(profileMarkerMatches(PI_SUBAGENTS_PROFILE, env({ PI_SUBAGENT_DEPTH: "" })), false);
  assert.equal(profileMarkerMatches(PI_SUBAGENTS_PROFILE, env({})), false);
});

test("profileMarkerMatches: a profile with no markers at all (pi-reference) never matches, by construction — its role always falls back to ancestry", () => {
  assert.equal(profileMarkerMatches(PI_REFERENCE_PROFILE, env({ ANYTHING: "1" })), false);
});
