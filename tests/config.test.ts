import assert from "node:assert/strict";
import { test } from "node:test";
import { detectRole, loadConfig, loadHubEnvCredentials, loadMachine, loadSyncConfig, validateHubUrl } from "../src/config.ts";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

test("loadConfig defaults dir, interactive tools and subagent tool", () => {
  const config = loadConfig(env({}));

  assert.equal(config.dir, ".kankaku");
  assert.deepEqual(config.interactiveTools, ["ask_user_question", "ask_user_choice"]);
  assert.equal(config.subagentTool, "subagent_run");
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

test("detectRole reports subagent when GENTLE_PI_AGENTS_CHILD=1", () => {
  assert.equal(detectRole(env({ GENTLE_PI_AGENTS_CHILD: "1" })), "subagent");
});

test("detectRole defaults to orchestrator", () => {
  assert.equal(detectRole(env({})), "orchestrator");
  assert.equal(detectRole(env({ GENTLE_PI_AGENTS_CHILD: "0" })), "orchestrator");
});

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

test("loadSyncConfig defaults to the conservative prompt mode, a 24h window, records and auto-sync enabled", () => {
  const config = loadSyncConfig(env({}));
  assert.equal(config.promptMode, "none");
  assert.equal(config.windowHours, 24);
  assert.equal(config.syncRecords, true);
  assert.equal(config.auto, true);
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
