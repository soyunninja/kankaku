import assert from "node:assert/strict";
import { test } from "node:test";
import { detectRole, loadConfig } from "../src/config.ts";

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
