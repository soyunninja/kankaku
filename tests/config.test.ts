import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectRole,
  loadConfig,
  loadHubEnvCredentials,
  loadMachine,
  loadSyncConfig,
  readRoleOverride,
  stripRoleOverride,
  validateHubUrl,
  validateSubagentChildEnvMarkers,
} from "../src/config.ts";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

test("loadConfig defaults dir, interactive tools and the built-in subagent profiles (gentle-pi, pi-reference, pi-subagents) — SUBAGENT_TOOL is no longer a hardcoded constant", () => {
  const config = loadConfig(env({}));

  assert.equal(config.dir, ".kankaku");
  assert.deepEqual(config.interactiveTools, ["ask_user_question", "ask_user_choice"]);
  assert.deepEqual(
    config.subagentProfiles.map((p) => p.id),
    ["gentle-pi", "pi-reference", "pi-subagents"],
  );
  // gentle-pi's own tool name is unchanged — no regression for existing users.
  assert.deepEqual(
    config.subagentProfiles.find((p) => p.id === "gentle-pi")?.toolNames,
    ["subagent_run"],
  );
});

test("SUBAGENT-REQ-002: loadConfig parses KANKAKU_SUBAGENT_TOOLS like KANKAKU_INTERACTIVE_TOOLS, additive to the built-in profiles", () => {
  const config = loadConfig(env({ KANKAKU_SUBAGENT_TOOLS: "my_tool, other_tool ," }));
  assert.deepEqual(
    config.subagentProfiles.map((p) => p.id),
    ["gentle-pi", "pi-reference", "pi-subagents", "configured"],
  );
  const configured = config.subagentProfiles.find((p) => p.id === "configured");
  assert.deepEqual(configured?.toolNames, ["my_tool", "other_tool"]);
});

test("SUBAGENT-REQ-003: loadConfig parses KANKAKU_SUBAGENT_CHILD_ENV as ';'-separated NAME[=VALUE] markers, skipping malformed entries", () => {
  const config = loadConfig(env({ KANKAKU_SUBAGENT_CHILD_ENV: "MY_CHILD=1; PRESENCE_ONLY ; =bad; TRAILING_EQ=" }));
  const configured = config.subagentProfiles.find((p) => p.id === "configured");
  assert.deepEqual(configured?.childEnvMarkers, [{ name: "MY_CHILD", value: "1" }, { name: "PRESENCE_ONLY" }]);
});

// --- C2 (CRITICAL fix): denylist for KANKAKU_SUBAGENT_CHILD_ENV — a marker
// name pi/the shell sets ambiently on every process must be rejected, not
// silently accepted as a "child-only" marker. ---

test("C2: validateSubagentChildEnvMarkers rejects PI_CODING_AGENT and AI_AGENT — pi sets these on EVERY process, not just a subagent's child", () => {
  const { accepted, rejected } = validateSubagentChildEnvMarkers([{ name: "PI_CODING_AGENT" }, { name: "AI_AGENT", value: "pi" }]);
  assert.deepEqual(accepted, []);
  assert.deepEqual(
    rejected.map((r) => r.name),
    ["PI_CODING_AGENT", "AI_AGENT"],
  );
  assert.ok(rejected.every((r) => r.reason.length > 0));
});

test("C2: validateSubagentChildEnvMarkers rejects generic shell/OS environment variables", () => {
  const names = ["PATH", "HOME", "USER", "SHELL", "PWD", "CI", "LANG", "TMUX"];
  const { accepted, rejected } = validateSubagentChildEnvMarkers(names.map((name) => ({ name })));
  assert.deepEqual(accepted, []);
  assert.equal(rejected.length, names.length);
});

test("C2: validateSubagentChildEnvMarkers rejects namespaced prefixes: PI_*, TERM*, LC_*, NODE_*, npm_*, KANKAKU_*", () => {
  const names = ["PI_SOME_SESSION_VAR", "TERM_PROGRAM", "TERM", "LC_ALL", "NODE_ENV", "npm_config_registry", "npm_lifecycle_event", "KANKAKU_DIR"];
  const { accepted, rejected } = validateSubagentChildEnvMarkers(names.map((name) => ({ name })));
  assert.deepEqual(accepted, []);
  assert.equal(rejected.length, names.length);
});

test("C2: validateSubagentChildEnvMarkers denylist matching is case-insensitive", () => {
  const { accepted, rejected } = validateSubagentChildEnvMarkers([{ name: "pi_coding_agent" }, { name: "Lc_Messages" }]);
  assert.deepEqual(accepted, []);
  assert.equal(rejected.length, 2);
});

test("C2: validateSubagentChildEnvMarkers accepts a genuine third-party marker name untouched", () => {
  const markers = [{ name: "MY_CUSTOM_TOOL_CHILD", value: "1" }, { name: "ACME_AGENT_DEPTH" }];
  const { accepted, rejected } = validateSubagentChildEnvMarkers(markers);
  assert.deepEqual(accepted, markers);
  assert.deepEqual(rejected, []);
});

test("C2: loadConfig strips a denylisted KANKAKU_SUBAGENT_CHILD_ENV marker from the configured profile and reports it as rejected", () => {
  const config = loadConfig(env({ KANKAKU_SUBAGENT_CHILD_ENV: "PI_CODING_AGENT;MY_CHILD=1" }));
  const configured = config.subagentProfiles.find((p) => p.id === "configured");
  assert.deepEqual(configured?.childEnvMarkers, [{ name: "MY_CHILD", value: "1" }]);
  assert.deepEqual(
    config.rejectedSubagentChildEnvMarkers.map((r) => r.name),
    ["PI_CODING_AGENT"],
  );
});

test("C2: loadConfig reports no rejected markers when none were configured, or all were accepted", () => {
  assert.deepEqual(loadConfig(env({})).rejectedSubagentChildEnvMarkers, []);
  assert.deepEqual(loadConfig(env({ KANKAKU_SUBAGENT_CHILD_ENV: "MY_CHILD=1" })).rejectedSubagentChildEnvMarkers, []);
});

test("C2: loadConfig still builds a 'configured' profile from tool names alone when every configured marker was denylisted (tools and markers are independent)", () => {
  const config = loadConfig(env({ KANKAKU_SUBAGENT_TOOLS: "my_tool", KANKAKU_SUBAGENT_CHILD_ENV: "CI" }));
  const configured = config.subagentProfiles.find((p) => p.id === "configured");
  assert.deepEqual(configured?.toolNames, ["my_tool"]);
  assert.deepEqual(configured?.childEnvMarkers, []);
});

test("loadConfig omits the 'configured' profile entirely when neither KANKAKU_SUBAGENT_TOOLS nor KANKAKU_SUBAGENT_CHILD_ENV is set — no inert extra profile", () => {
  const config = loadConfig(env({}));
  assert.equal(
    config.subagentProfiles.some((p) => p.id === "configured"),
    false,
  );
});

test("loadConfig reads KANKAKU_DIR and KANKAKU_INTERACTIVE_TOOLS", () => {
  const config = loadConfig(
    env({
      KANKAKU_DIR: "/abs/dir",
      KANKAKU_INTERACTIVE_TOOLS: "ask_user_question, custom_tool",
    }),
  );

  assert.equal(config.dir, "/abs/dir");
  assert.deepEqual(config.interactiveTools, ["ask_user_question", "custom_tool"]);
});

test("loadConfig defaults segmentRules to the built-in review rule", () => {
  const config = loadConfig(env({}));

  assert.equal(config.segmentRules.length, 1);
  const [rule] = config.segmentRules;
  assert.equal(rule?.tag, "review");
  assert.equal(rule?.tool, "bash");
  assert.equal(rule?.pattern.test("gentle-ai review start"), true);
  assert.equal(rule?.pattern.test("gentle-air review"), false);
});

test("loadConfig parses KANKAKU_SEGMENTS into multiple rules", () => {
  const config = loadConfig(env({ KANKAKU_SEGMENTS: "review=bash:gentle-ai review;commit=bash:git commit" }));

  assert.equal(config.segmentRules.length, 2);
  assert.deepEqual(
    config.segmentRules.map((rule) => [rule.tag, rule.tool, rule.pattern.source]),
    [
      ["review", "bash", "gentle-ai review"],
      ["commit", "bash", "git commit"],
    ],
  );
});

test("loadConfig skips invalid KANKAKU_SEGMENTS entries but keeps valid ones", () => {
  const config = loadConfig(
    env({
      KANKAKU_SEGMENTS: "missing-colon-rule;=bash:no-tag;tag-only=;valid=bash:git push;bad=bash:[",
    }),
  );

  assert.deepEqual(
    config.segmentRules.map((rule) => rule.tag),
    ["valid"],
  );
});

test("loadConfig skips a segment rule tagged __proto__ (or another unsafe tag) but keeps a valid one", () => {
  const config = loadConfig(
    env({
      KANKAKU_SEGMENTS: "__proto__=bash:x;constructor=bash:y;has space=bash:z;valid-tag_1=bash:git push",
    }),
  );

  assert.deepEqual(
    config.segmentRules.map((rule) => rule.tag),
    ["valid-tag_1"],
  );
});

test("loadConfig trims whitespace around KANKAKU_SEGMENTS entries", () => {
  const config = loadConfig(env({ KANKAKU_SEGMENTS: "  review = bash : gentle-ai review  ;  commit=bash:git commit  " }));

  assert.deepEqual(
    config.segmentRules.map((rule) => [rule.tag, rule.tool, rule.pattern.source]),
    [
      ["review", "bash", "gentle-ai review"],
      ["commit", "bash", "git commit"],
    ],
  );
});

test("loadConfig leaves client undefined when KANKAKU_CLIENT is unset", () => {
  const config = loadConfig(env({}));
  assert.equal(config.client, undefined);
});

test("loadConfig reads KANKAKU_CLIENT", () => {
  const config = loadConfig(env({ KANKAKU_CLIENT: "acme" }));
  assert.equal(config.client, "acme");
});

test("detectRole reports subagent when GENTLE_PI_AGENTS_CHILD=1, regardless of a tracked ancestor", () => {
  assert.deepEqual(detectRole(env({ GENTLE_PI_AGENTS_CHILD: "1" })), { role: "subagent" });
  assert.deepEqual(detectRole(env({ GENTLE_PI_AGENTS_CHILD: "1" }), true, false), { role: "subagent" });
});

test("detectRole defaults to a confirmed orchestrator when no marker matches and no tracked ancestor was found", () => {
  assert.deepEqual(detectRole(env({})), { role: "orchestrator" });
  assert.deepEqual(detectRole(env({ GENTLE_PI_AGENTS_CHILD: "0" })), { role: "orchestrator" });
  assert.deepEqual(detectRole(env({}), false), { role: "orchestrator" });
});

test("detectRole classifies an unmarked, non-interactive process with a tracked ancestor as uncertain, never orchestrator outright (ADR 0022, SUBAGENT-REQ-013)", () => {
  assert.deepEqual(detectRole(env({}), true, false), { role: "orchestrator", roleConfidence: "uncertain" });
});

test("detectRole never classifies an interactive (TUI) process as uncertain, even with a tracked ancestor (F3: a genuine human session is never demoted)", () => {
  assert.deepEqual(detectRole(env({}), true, true), { role: "orchestrator" });
  // isInteractive defaults to true when the caller does not know yet.
  assert.deepEqual(detectRole(env({}), true), { role: "orchestrator" });
});

test("KANKAKU_ROLE=subagent overrides detection outright for a non-interactive process, even with no tracked ancestor and no GENTLE_PI_AGENTS_CHILD marker", () => {
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "subagent" }), false, false), { role: "subagent" });
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "subagent" }), true, false), { role: "subagent" });
});

test("KANKAKU_ROLE=orchestrator overrides detection outright, forcing a confirmed orchestrator even with a tracked, non-interactive ancestor", () => {
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "orchestrator" }), true, false), { role: "orchestrator" });
});

test("R1 (BLOCKER): a confirmed child marker (GENTLE_PI_AGENTS_CHILD=1) always takes precedence over KANKAKU_ROLE=orchestrator — a leaked shell export must never turn a real subagent into a confirmed, independently-billed orchestrator", () => {
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "orchestrator", GENTLE_PI_AGENTS_CHILD: "1" })), { role: "subagent" });
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "orchestrator", GENTLE_PI_AGENTS_CHILD: "1" }), true, false), { role: "subagent" });
});

test("R1: a confirmed child marker and a consistent KANKAKU_ROLE=subagent agree — role is subagent regardless of interactivity", () => {
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "subagent", GENTLE_PI_AGENTS_CHILD: "1" }), false, true), { role: "subagent" });
});

test("R1: KANKAKU_ROLE=subagent with no confirmed marker is IGNORED for an interactive (TUI) session — almost certainly a leaked shell export, so it is treated as the orchestrator it structurally must be, and flagged", () => {
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "subagent" }), false, true), { role: "orchestrator", overrideIgnoredInteractive: true });
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "subagent" })), { role: "orchestrator", overrideIgnoredInteractive: true }); // isInteractive defaults to true
  // A tracked ancestor does not change this — the interactivity contradiction is decided first.
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "subagent" }), true, true), { role: "orchestrator", overrideIgnoredInteractive: true });
});

test("an invalid KANKAKU_ROLE value is ignored, falling back to normal detection", () => {
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "bogus" })), { role: "orchestrator" });
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "" })), { role: "orchestrator" });
  assert.deepEqual(detectRole(env({ KANKAKU_ROLE: "  " })), { role: "orchestrator" });
});

test("SUBAGENT-REQ-002/003/024: detectRole's 4th param generalises the confirmed-marker check beyond GENTLE_PI_AGENTS_CHILD, still taking precedence over KANKAKU_ROLE and tracked-ancestor uncertainty", () => {
  const markers = [{ name: "GENTLE_PI_AGENTS_CHILD", value: "1" }, { name: "MY_CHILD", value: "1" }];
  assert.deepEqual(detectRole(env({ MY_CHILD: "1" }), false, true, markers), { role: "subagent" });
  assert.deepEqual(detectRole(env({ MY_CHILD: "1", KANKAKU_ROLE: "orchestrator" }), false, true, markers), { role: "subagent" });
  // A marker unknown to the active profile set never confirms a subagent by itself.
  assert.deepEqual(detectRole(env({ MY_CHILD: "1" }), false, true), { role: "orchestrator" });
});

test("detectRole's default childMarkers (no 4th arg) is unchanged: only GENTLE_PI_AGENTS_CHILD=1 confirms — every pre-existing 3-arg call site keeps behaving exactly as before", () => {
  assert.deepEqual(detectRole(env({ GENTLE_PI_AGENTS_CHILD: "1" }), false, true), { role: "subagent" });
  assert.deepEqual(detectRole(env({ PI_SUBAGENT_DEPTH: "1" }), false, true), { role: "orchestrator" });
});

// --- C2 (CRITICAL fix): a user-configured marker is a SEPARATE, weaker
// tier from the built-in `childMarkers` — it can confirm a subagent, but
// unlike a built-in marker, never demotes an interactive session. ---

test("C2: a configured marker confirms subagent for a NON-interactive process, exactly like a built-in one", () => {
  const configured = [{ name: "MY_CHILD", value: "1" }];
  assert.deepEqual(detectRole(env({ MY_CHILD: "1" }), false, false, [], configured), { role: "subagent" });
});

test("C2: a configured marker is IGNORED for an interactive process — role stays orchestrator, and configuredMarkerIgnoredInteractive is set (never silently trusted)", () => {
  const configured = [{ name: "MY_CHILD", value: "1" }];
  const result = detectRole(env({ MY_CHILD: "1" }), false, true, [], configured);
  assert.deepEqual(result, { role: "orchestrator", configuredMarkerIgnoredInteractive: true });
});

test("C2: a configured marker ignored for interactivity is unaffected by a tracked ancestor — the uncertain/ancestor check only ever applies to a NON-interactive process, and this one is interactive", () => {
  const configured = [{ name: "MY_CHILD", value: "1" }];
  const result = detectRole(env({ MY_CHILD: "1" }), true, true, [], configured);
  assert.deepEqual(result, { role: "orchestrator", configuredMarkerIgnoredInteractive: true });
});

test("C2: a configured marker present together with KANKAKU_ROLE=orchestrator, interactive — both agree, but the marker is still flagged as ignored (it was never actually needed to decide this)", () => {
  const configured = [{ name: "MY_CHILD", value: "1" }];
  const result = detectRole(env({ MY_CHILD: "1", KANKAKU_ROLE: "orchestrator" }), false, true, [], configured);
  assert.deepEqual(result, { role: "orchestrator", configuredMarkerIgnoredInteractive: true });
});

test("C2: a configured marker present together with KANKAKU_ROLE=subagent, interactive — both flags surface (both were ignored for the same reason)", () => {
  const configured = [{ name: "MY_CHILD", value: "1" }];
  const result = detectRole(env({ MY_CHILD: "1", KANKAKU_ROLE: "subagent" }), false, true, [], configured);
  assert.deepEqual(result, { role: "orchestrator", overrideIgnoredInteractive: true, configuredMarkerIgnoredInteractive: true });
});

test("C2: a BUILT-IN marker still wins outright over interactivity — the interactive exception applies ONLY to the configured tier, never to childMarkers", () => {
  const result = detectRole(env({ GENTLE_PI_AGENTS_CHILD: "1" }), false, true, [{ name: "GENTLE_PI_AGENTS_CHILD", value: "1" }], []);
  assert.deepEqual(result, { role: "subagent" });
});

test("C2: no configured marker present -> configuredMarkerIgnoredInteractive is never set, regardless of interactivity", () => {
  assert.deepEqual(detectRole(env({}), false, true, [], [{ name: "MY_CHILD", value: "1" }]), { role: "orchestrator" });
  assert.deepEqual(detectRole(env({}), false, false, [], [{ name: "MY_CHILD", value: "1" }]), { role: "orchestrator" });
});

test("C2: an unmarked, non-interactive process with a tracked ancestor is still 'uncertain' when a configured marker (not present) is also active — unaffected by an absent configured tier", () => {
  const configured = [{ name: "MY_CHILD", value: "1" }];
  assert.deepEqual(detectRole(env({}), true, false, [], configured), { role: "orchestrator", roleConfidence: "uncertain" });
});

// C2 precedence matrix: configuredMarker × override × hasTrackedAncestor × isInteractive.
const CONFIGURED_MARKER_MATRIX: Array<{
  configuredMarker: boolean;
  override: "orchestrator" | "subagent" | undefined;
  hasTrackedAncestor: boolean;
  isInteractive: boolean;
  expected: ReturnType<typeof detectRole>;
}> = [];

for (const configuredMarker of [true, false]) {
  for (const override of ["orchestrator", "subagent", undefined] as const) {
    for (const hasTrackedAncestor of [true, false]) {
      for (const isInteractive of [true, false]) {
        let base: ReturnType<typeof detectRole>;
        if (configuredMarker && !isInteractive) {
          base = { role: "subagent" };
        } else if (override === "orchestrator") {
          base = { role: "orchestrator" };
        } else if (override === "subagent") {
          base = isInteractive ? { role: "orchestrator", overrideIgnoredInteractive: true } : { role: "subagent" };
        } else if (hasTrackedAncestor && !isInteractive) {
          base = { role: "orchestrator", roleConfidence: "uncertain" };
        } else {
          base = { role: "orchestrator" };
        }
        const expected = configuredMarker && isInteractive ? { ...base, configuredMarkerIgnoredInteractive: true as const } : base;
        CONFIGURED_MARKER_MATRIX.push({ configuredMarker, override, hasTrackedAncestor, isInteractive, expected });
      }
    }
  }
}

for (const { configuredMarker, override, hasTrackedAncestor, isInteractive, expected } of CONFIGURED_MARKER_MATRIX) {
  test(`C2 configured-marker matrix: configuredMarker=${configuredMarker} override=${override ?? "none"} hasTrackedAncestor=${hasTrackedAncestor} isInteractive=${isInteractive} -> ${JSON.stringify(expected)}`, () => {
    const overrides: Record<string, string | undefined> = {};
    if (configuredMarker) overrides["MY_CHILD"] = "1";
    if (override) overrides["KANKAKU_ROLE"] = override;
    const configured = [{ name: "MY_CHILD", value: "1" }];
    assert.deepEqual(detectRole(env(overrides), hasTrackedAncestor, isInteractive, [], configured), expected);
  });
}

test("readRoleOverride reads and validates KANKAKU_ROLE", () => {
  assert.equal(readRoleOverride(env({ KANKAKU_ROLE: "subagent" })), "subagent");
  assert.equal(readRoleOverride(env({ KANKAKU_ROLE: "orchestrator" })), "orchestrator");
  assert.equal(readRoleOverride(env({ KANKAKU_ROLE: "nope" })), undefined);
  assert.equal(readRoleOverride(env({})), undefined);
});

test("stripRoleOverride removes KANKAKU_ROLE from the given env object in place, never touching real process.env (R1, layer 2)", () => {
  const fakeEnv = env({ KANKAKU_ROLE: "orchestrator", OTHER: "kept" });
  stripRoleOverride(fakeEnv);
  assert.equal(fakeEnv["KANKAKU_ROLE"], undefined);
  assert.equal(fakeEnv["OTHER"], "kept");
  // The real process.env is never touched by this test — stripRoleOverride
  // only ever acts on the object it is given.
  assert.notEqual(process.env, fakeEnv);
});

test("stripRoleOverride is a harmless no-op when KANKAKU_ROLE was never set", () => {
  const fakeEnv = env({ OTHER: "kept" });
  assert.doesNotThrow(() => stripRoleOverride(fakeEnv));
  assert.equal(fakeEnv["OTHER"], "kept");
});

// R1: the full precedence table, every combination of marker × override ×
// tracked-ancestor × interactive. ("detection-unavailable" — an ancestor
// search that could not run at all — is indistinguishable from "no
// ancestor found" at this pure layer: both are simply hasTrackedAncestor
// = false, already covered below; the distinction only matters for
// `/kankaku doctor`'s own separate `ancestorDetectionAvailable` report.)
const PRECEDENCE_MATRIX: Array<{
  marker: boolean;
  override: "orchestrator" | "subagent" | undefined;
  hasTrackedAncestor: boolean;
  isInteractive: boolean;
  expected: ReturnType<typeof detectRole>;
}> = [];

for (const marker of [true, false]) {
  for (const override of ["orchestrator", "subagent", undefined] as const) {
    for (const hasTrackedAncestor of [true, false]) {
      for (const isInteractive of [true, false]) {
        let expected: ReturnType<typeof detectRole>;
        if (marker) {
          // A confirmed child marker always wins — nothing else matters.
          expected = { role: "subagent" };
        } else if (override === "orchestrator") {
          expected = { role: "orchestrator" };
        } else if (override === "subagent") {
          expected = isInteractive ? { role: "orchestrator", overrideIgnoredInteractive: true } : { role: "subagent" };
        } else if (hasTrackedAncestor && !isInteractive) {
          expected = { role: "orchestrator", roleConfidence: "uncertain" };
        } else {
          expected = { role: "orchestrator" };
        }
        PRECEDENCE_MATRIX.push({ marker, override, hasTrackedAncestor, isInteractive, expected });
      }
    }
  }
}

for (const { marker, override, hasTrackedAncestor, isInteractive, expected } of PRECEDENCE_MATRIX) {
  test(`R1 precedence matrix: marker=${marker} override=${override ?? "none"} hasTrackedAncestor=${hasTrackedAncestor} isInteractive=${isInteractive} -> ${JSON.stringify(expected)}`, () => {
    const overrides: Record<string, string | undefined> = {};
    if (marker) overrides["GENTLE_PI_AGENTS_CHILD"] = "1";
    if (override) overrides["KANKAKU_ROLE"] = override;
    assert.deepEqual(detectRole(env(overrides), hasTrackedAncestor, isInteractive), expected);
  });
}

test("loadHubEnvCredentials reads KANKAKU_PB_URL/EMAIL/PASSWORD", () => {
  const creds = loadHubEnvCredentials(
    env({ KANKAKU_PB_URL: "https://pb.example.com", KANKAKU_PB_EMAIL: "bot@example.com", KANKAKU_PB_PASSWORD: "secret" }),
  );
  assert.deepEqual(creds, { url: "https://pb.example.com", email: "bot@example.com", password: "secret" });
});

test("loadHubEnvCredentials leaves fields undefined when unset or blank", () => {
  const creds = loadHubEnvCredentials(env({ KANKAKU_PB_URL: "  " }));
  assert.deepEqual(creds, { url: undefined, email: undefined, password: undefined });
});

test("loadMachine reads KANKAKU_MACHINE, defaulting to the injected hostname", () => {
  assert.equal(loadMachine(env({ KANKAKU_MACHINE: "my-laptop" }), () => "real-hostname"), "my-laptop");
  assert.equal(loadMachine(env({}), () => "real-hostname"), "real-hostname");
  assert.equal(loadMachine(env({ KANKAKU_MACHINE: "  " }), () => "real-hostname"), "real-hostname");
});

test("validateHubUrl accepts https URLs", () => {
  assert.deepEqual(validateHubUrl("https://pb.example.com"), { ok: true });
});

test("validateHubUrl accepts plain HTTP only for localhost/127.0.0.1/::1", () => {
  assert.deepEqual(validateHubUrl("http://localhost:8090"), { ok: true });
  assert.deepEqual(validateHubUrl("http://127.0.0.1:8090"), { ok: true });
  assert.deepEqual(validateHubUrl("http://[::1]:8090"), { ok: true });
});

test("validateHubUrl rejects plain HTTP for a non-local host", () => {
  const result = validateHubUrl("http://pb.example.com");
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /refusing non-HTTPS/);
});

test("validateHubUrl rejects a URL that does not parse", () => {
  const result = validateHubUrl("not a url");
  assert.equal(result.ok, false);
});

test("loadSyncConfig defaults to the conservative prompt mode, a 24h window, records and auto-sync enabled, and a 5-minute auto-sync throttle", () => {
  const config = loadSyncConfig(env({}));
  assert.equal(config.promptMode, "none");
  assert.equal(config.windowHours, 24);
  assert.equal(config.syncRecords, true);
  assert.equal(config.auto, true);
  assert.equal(config.minIntervalMinutes, 5);
});

test("loadSyncConfig reads KANKAKU_SYNC_PROMPT, falling back to none for an unrecognised value", () => {
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_PROMPT: "truncated" })).promptMode, "truncated");
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_PROMPT: "full" })).promptMode, "full");
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_PROMPT: "bogus" })).promptMode, "none");
});

test("loadSyncConfig reads KANKAKU_SYNC_WINDOW_HOURS, falling back to 24 for a non-positive or non-numeric value", () => {
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_WINDOW_HOURS: "6" })).windowHours, 6);
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_WINDOW_HOURS: "0" })).windowHours, 24);
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_WINDOW_HOURS: "-3" })).windowHours, 24);
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_WINDOW_HOURS: "not-a-number" })).windowHours, 24);
});

test("loadSyncConfig: KANKAKU_SYNC_RECORDS=0 disables work_records upload", () => {
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_RECORDS: "0" })).syncRecords, false);
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_RECORDS: "1" })).syncRecords, true);
});

test("loadSyncConfig: KANKAKU_SYNC_AUTO=0 disables automatic sync", () => {
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_AUTO: "0" })).auto, false);
  assert.equal(loadSyncConfig(env({})).auto, true);
});

test("loadSyncConfig reads KANKAKU_SYNC_MIN_INTERVAL_MINUTES, treating 0 as a valid explicit 'disabled' value distinct from an unset/invalid one", () => {
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_MIN_INTERVAL_MINUTES: "10" })).minIntervalMinutes, 10);
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_MIN_INTERVAL_MINUTES: "0" })).minIntervalMinutes, 0);
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_MIN_INTERVAL_MINUTES: "-3" })).minIntervalMinutes, 5);
  assert.equal(loadSyncConfig(env({ KANKAKU_SYNC_MIN_INTERVAL_MINUTES: "not-a-number" })).minIntervalMinutes, 5);
});
