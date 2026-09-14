import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkTracker } from "../src/domain/work-tracker.ts";
import type { Clock } from "../src/ports/clock.ts";
import type { SegmentRule } from "../src/domain/segment-rule.ts";

class FakeClock implements Clock {
  private current: number;

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advanceTo(ms: number): void {
    this.current = ms;
  }
}

function makeTracker(clock: Clock, segmentRules: SegmentRule[] = []): WorkTracker {
  return new WorkTracker({
    clock,
    interactiveTools: ["ask_user_question", "ask_user_choice"],
    subagentTool: "subagent_run",
    segmentRules,
  });
}

const REVIEW_RULE: SegmentRule = { tag: "review", tool: "bash", pattern: /\bgentle-ai review\b/ };

test("single run produces a completed record with no waiting", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("hello there");
  clock.advanceTo(1000);
  const record = tracker.onSettled();

  assert.ok(record);
  assert.equal(record?.prompt, "hello there");
  assert.equal(record?.runs, 1);
  assert.equal(record?.wallMs, 1000);
  assert.equal(record?.waitingMs, 0);
  assert.equal(record?.workMs, 1000);
  assert.equal(record?.status, "completed");
});

test("onSettled returns undefined when idle", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  assert.equal(tracker.onSettled(), undefined);
});

test("multiple runs before settle increments runs and keeps the first prompt", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("first prompt");
  clock.advanceTo(200);
  tracker.onRunStart("retry prompt");
  clock.advanceTo(500);
  tracker.onRunStart("follow up prompt");
  clock.advanceTo(900);

  const record = tracker.onSettled();

  assert.equal(record?.prompt, "first prompt");
  assert.equal(record?.runs, 3);
  assert.equal(record?.wallMs, 900);
});

test("waiting time from an interactive tool span is subtracted from work", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  clock.advanceTo(100);
  tracker.onToolStart("call-1", "ask_user_question", {});
  clock.advanceTo(400);
  tracker.onToolEnd("call-1", {});
  clock.advanceTo(1000);

  const record = tracker.onSettled();

  assert.equal(record?.wallMs, 1000);
  assert.equal(record?.waitingMs, 300);
  assert.equal(record?.workMs, 700);
});

test("overlapping waiting spans are unioned, not summed", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  clock.advanceTo(100);
  tracker.onToolStart("call-1", "ask_user_question", {});
  clock.advanceTo(200);
  tracker.onUiPromptStart("select");
  clock.advanceTo(400);
  tracker.onToolEnd("call-1", {});
  clock.advanceTo(500);
  tracker.onUiPromptEnd("select");
  clock.advanceTo(1000);

  const record = tracker.onSettled();

  // union of [100,400] and [200,500] is [100,500] => 400ms, not 600ms.
  assert.equal(record?.waitingMs, 400);
  assert.equal(record?.workMs, 600);
});

test("subagent_run spans are captured with agent, mode, taskId and ms", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  clock.advanceTo(50);
  tracker.onToolStart("call-2", "subagent_run", { agent: "sdd-explore", mode: "task" });
  clock.advanceTo(9050);
  tracker.onToolEnd("call-2", { details: { gentleAgents: { taskId: "t1" } } });
  clock.advanceTo(10000);

  const record = tracker.onSettled();

  assert.equal(record?.subagents.length, 1);
  assert.deepEqual(record?.subagents[0], {
    toolCallId: "call-2",
    agent: "sdd-explore",
    mode: "task",
    taskId: "t1",
    ms: 9000,
  });
  // subagent spans are not counted as waiting time.
  assert.equal(record?.waitingMs, 0);
});

test("subagent_run defaults mode to task when args omit it", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-3", "subagent_run", { agent: "sdd-explore" });
  clock.advanceTo(100);
  tracker.onToolEnd("call-3", {});
  const record = tracker.onSettled();

  assert.equal(record?.subagents[0]?.mode, "task");
  assert.equal(record?.subagents[0]?.taskId, undefined);
});

test("tool counts are accumulated by tool name", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "bash", {});
  tracker.onToolEnd("call-1", {});
  tracker.onToolStart("call-2", "bash", {});
  tracker.onToolEnd("call-2", {});
  tracker.onToolStart("call-3", "read", {});
  tracker.onToolEnd("call-3", {});
  const record = tracker.onSettled();

  assert.deepEqual(record?.tools, { bash: 2, read: 1 });
});

test("usage is accumulated across turns", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  tracker.onTurnEnd({ input: 10, output: 20, cacheRead: 1, cacheWrite: 2, cost: 0.01 });
  tracker.onTurnEnd({ input: 5, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0.02 });
  const record = tracker.onSettled();

  assert.equal(record?.turns, 2);
  assert.deepEqual(record?.usage, { input: 15, output: 28, cacheRead: 1, cacheWrite: 2, cost: 0.03 });
});

test("onRunEnd marks the record aborted when the last assistant message aborted", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  tracker.onRunEnd([
    { role: "user" },
    { role: "assistant", stopReason: "aborted" },
  ]);
  const record = tracker.onSettled();

  assert.equal(record?.status, "aborted");
});

test("onRunEnd keeps completed status when the last assistant message did not abort", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  tracker.onRunEnd([
    { role: "user" },
    { role: "assistant", stopReason: "stop" },
  ]);
  const record = tracker.onSettled();

  assert.equal(record?.status, "completed");
});

test("onShutdown while running closes the record as interrupted", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  clock.advanceTo(300);
  const record = tracker.onShutdown();

  assert.equal(record?.status, "interrupted");
  assert.equal(record?.wallMs, 300);
});

test("onShutdown while idle returns undefined", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  assert.equal(tracker.onShutdown(), undefined);
});

test("unclosed waiting and subagent spans truncate at settle time", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  clock.advanceTo(100);
  tracker.onToolStart("call-1", "ask_user_question", {});
  clock.advanceTo(1000);
  const record = tracker.onSettled();

  assert.equal(record?.waitingMs, 900);
  assert.equal(record?.workMs, 100);
});

test("tracker returns to idle after settle and can start a new record", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("first");
  clock.advanceTo(100);
  tracker.onSettled();

  tracker.onRunStart("second");
  clock.advanceTo(250);
  const record = tracker.onSettled();

  assert.equal(record?.prompt, "second");
  assert.equal(record?.wallMs, 150);
});

test("a non-interactive tool ending does not close an open waiting span", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("parallel tools");
  clock.advanceTo(1000);
  tracker.onToolStart("ask-1", "ask_user_question", {});
  tracker.onToolStart("bash-1", "bash", { command: "ls" });
  clock.advanceTo(2000);
  tracker.onToolEnd("bash-1", { content: [] });
  clock.advanceTo(5000);
  tracker.onToolEnd("ask-1", { content: [] });
  clock.advanceTo(6000);
  const record = tracker.onSettled();

  assert.equal(record?.wallMs, 6000);
  assert.equal(record?.waitingMs, 4000);
  assert.equal(record?.workMs, 2000);
});

test("a bash call matching the review pattern is tagged and timed as a segment", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [REVIEW_RULE]);

  tracker.onRunStart("prompt");
  clock.advanceTo(100);
  tracker.onToolStart("call-1", "bash", { command: "gentle-ai review start" });
  clock.advanceTo(500);
  tracker.onToolEnd("call-1", {});
  clock.advanceTo(1000);

  const record = tracker.onSettled();

  assert.deepEqual(record?.segments, { review: 400 });
});

test("a non-matching tool name does not open a segment even if the command matches", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [REVIEW_RULE]);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "shell", { command: "gentle-ai review start" });
  clock.advanceTo(200);
  tracker.onToolEnd("call-1", {});
  const record = tracker.onSettled();

  assert.deepEqual(record?.segments, {});
});

test("a non-matching command does not open a segment", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [REVIEW_RULE]);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "bash", { command: "ls -la" });
  clock.advanceTo(200);
  tracker.onToolEnd("call-1", {});
  const record = tracker.onSettled();

  assert.deepEqual(record?.segments, {});
});

test("two overlapping matching calls are unioned, not summed, for the same tag", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [REVIEW_RULE]);

  tracker.onRunStart("prompt");
  clock.advanceTo(100);
  tracker.onToolStart("call-1", "bash", { command: "gentle-ai review start" });
  clock.advanceTo(200);
  tracker.onToolStart("call-2", "bash", { command: "gentle-ai review status" });
  clock.advanceTo(400);
  tracker.onToolEnd("call-1", {});
  clock.advanceTo(500);
  tracker.onToolEnd("call-2", {});
  clock.advanceTo(1000);

  const record = tracker.onSettled();

  // union of [100,400] and [200,500] is [100,500] => 400ms, not 600ms.
  assert.deepEqual(record?.segments, { review: 400 });
});

test("an unclosed segment span truncates at settle time", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [REVIEW_RULE]);

  tracker.onRunStart("prompt");
  clock.advanceTo(100);
  tracker.onToolStart("call-1", "bash", { command: "gentle-ai review start" });
  clock.advanceTo(1000);

  const record = tracker.onSettled();

  assert.deepEqual(record?.segments, { review: 900 });
});

test("an unclosed segment span truncates at shutdown time", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [REVIEW_RULE]);

  tracker.onRunStart("prompt");
  clock.advanceTo(50);
  tracker.onToolStart("call-1", "bash", { command: "gentle-ai review start" });
  clock.advanceTo(300);

  const record = tracker.onShutdown();

  assert.deepEqual(record?.segments, { review: 250 });
});

test("only the first matching rule applies to a given tool call", () => {
  const clock = new FakeClock(0);
  const first: SegmentRule = { tag: "review", tool: "bash", pattern: /gentle-ai/ };
  const second: SegmentRule = { tag: "other", tool: "bash", pattern: /review/ };
  const tracker = makeTracker(clock, [first, second]);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "bash", { command: "gentle-ai review start" });
  clock.advanceTo(100);
  tracker.onToolEnd("call-1", {});
  const record = tracker.onSettled();

  assert.deepEqual(record?.segments, { review: 100 });
});

test("non-string args fall back to a JSON.stringify match for non-bash tools", () => {
  const clock = new FakeClock(0);
  const rule: SegmentRule = { tag: "gentle", tool: "custom_tool", pattern: /"cmd":"gentle-ai review"/ };
  const tracker = makeTracker(clock, [rule]);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "custom_tool", { cmd: "gentle-ai review" });
  clock.advanceTo(150);
  tracker.onToolEnd("call-1", {});
  const record = tracker.onSettled();

  assert.deepEqual(record?.segments, { gentle: 150 });
});

test("a segment rule tagged __proto__ produces a plain object segments with that own key", () => {
  const clock = new FakeClock(0);
  const rule: SegmentRule = { tag: "__proto__", tool: "bash", pattern: /x/ };
  const tracker = makeTracker(clock, [rule]);

  tracker.onRunStart("prompt");
  clock.advanceTo(100);
  tracker.onToolStart("call-1", "bash", { command: "x" });
  clock.advanceTo(200);
  tracker.onToolEnd("call-1", {});
  const record = tracker.onSettled();

  assert.ok(record);
  const segments = record!.segments as Record<string, number>;
  assert.equal(Object.getPrototypeOf(segments), Object.prototype);
  assert.equal(Object.hasOwn(segments, "__proto__"), true);
  assert.deepEqual(Object.keys(segments), ["__proto__"]);
  assert.equal(segments["__proto__"], 100);
});

test("usage accumulation ignores non-finite numbers and treats missing fields as zero", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  tracker.onTurnEnd({ input: 5, output: Number.NaN, cost: Number.POSITIVE_INFINITY });
  const record = tracker.onSettled();

  assert.deepEqual(record?.usage, { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
});

test("peek while running returns a record with the same id as the later settled record", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  clock.advanceTo(100);
  const peeked = tracker.peek("interrupted");
  clock.advanceTo(500);
  const settled = tracker.onSettled();

  assert.ok(peeked);
  assert.ok(settled);
  assert.equal(peeked?.id, settled?.id);
  assert.equal(peeked?.status, "interrupted");
  assert.equal(peeked?.wallMs, 100);
  assert.equal(settled?.status, "completed");
  assert.equal(settled?.wallMs, 500);
});

test("peek does not close open spans and the tracker keeps running afterwards", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  clock.advanceTo(100);
  tracker.onToolStart("call-1", "ask_user_question", {});
  clock.advanceTo(300);
  const peeked = tracker.peek("interrupted");
  assert.equal(peeked?.waitingMs, 200); // [100,300] truncated at peek time

  clock.advanceTo(400);
  tracker.onToolEnd("call-1", {});
  clock.advanceTo(1000);
  const settled = tracker.onSettled();

  assert.equal(settled?.waitingMs, 300); // [100,400], unaffected by the earlier peek
  assert.equal(settled?.wallMs, 1000);
});

test("peek when idle returns undefined", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  assert.equal(tracker.peek("interrupted"), undefined);
});

test("a run with no segment rules produces an empty segments object", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, []);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "bash", { command: "gentle-ai review start" });
  clock.advanceTo(100);
  tracker.onToolEnd("call-1", {});
  const record = tracker.onSettled();

  assert.deepEqual(record?.segments, {});
});
