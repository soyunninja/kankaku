import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkTracker } from "../src/domain/work-tracker.ts";
import type { Clock } from "../src/ports/clock.ts";
import type { SegmentRule } from "../src/domain/segment-rule.ts";
import { BUILTIN_SUBAGENT_PROFILES, GENTLE_PI_PROFILE, PI_REFERENCE_PROFILE, PI_SUBAGENTS_PROFILE } from "../src/domain/subagent-profile.ts";
import type { SubagentProfile } from "../src/domain/subagent-profile.ts";

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

function makeTracker(clock: Clock, segmentRules: SegmentRule[] = [], subagentProfiles: SubagentProfile[] = BUILTIN_SUBAGENT_PROFILES as SubagentProfile[]): WorkTracker {
  return new WorkTracker({
    clock,
    interactiveTools: ["ask_user_question", "ask_user_choice"],
    subagentProfiles,
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
    // SUBAGENT-REQ-005/017 (6b): the span now also carries which profile
    // matched — "gentle-pi", unambiguously, since only that profile
    // registers "subagent_run". Every other field/value is unchanged.
    profile: "gentle-pi",
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
  // A non-finite cost is not a real observed figure — same as absent.
  assert.equal(record?.costObserved, undefined);
});

test("costObserved is set when at least one turn reports a real (finite) cost figure", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  tracker.onTurnEnd({ input: 1, output: 1, cost: 0 }); // a real, explicit zero cost still counts as observed
  const record = tracker.onSettled();

  assert.equal(record?.costObserved, true);
});

test("costObserved stays unset when no turn ever reports a cost figure (subscription/OAuth providers)", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  tracker.onTurnEnd({ input: 1, output: 1 }); // no cost key at all
  tracker.onTurnEnd(undefined);
  const record = tracker.onSettled();

  assert.equal(record?.costObserved, undefined);
});

test("costObserved stays true for the rest of the run once any turn observed a real cost", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  tracker.onTurnEnd({ input: 1, output: 1, cost: 0.5 });
  tracker.onTurnEnd({ input: 1, output: 1 }); // this later turn has no cost, must not erase the earlier observation
  const record = tracker.onSettled();

  assert.equal(record?.costObserved, true);
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

test("wallMs, waitingMs and workMs are clamped to zero when the clock jumps backward before settle", () => {
  const clock = new FakeClock(1000);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  clock.advanceTo(500); // clock jumped backward
  const record = tracker.onSettled();

  assert.equal(record?.wallMs, 0);
  assert.equal(record?.waitingMs, 0);
  assert.equal(record?.workMs, 0);
});

test("wallMs, waitingMs and workMs are clamped to zero when the clock jumps backward before shutdown", () => {
  const clock = new FakeClock(1000);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  clock.advanceTo(200); // clock jumped backward
  const record = tracker.onShutdown();

  assert.equal(record?.wallMs, 0);
  assert.equal(record?.waitingMs, 0);
  assert.equal(record?.workMs, 0);
});

test("a subagent span's ms is clamped to zero when the clock jumps backward mid-span", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  clock.advanceTo(9000);
  tracker.onToolStart("call-1", "subagent_run", { agent: "sdd-explore", mode: "task" });
  clock.advanceTo(3000); // clock jumped backward while the subagent was running
  tracker.onToolEnd("call-1", {});
  clock.advanceTo(9100);

  const record = tracker.onSettled();

  assert.equal(record?.subagents[0]?.ms, 0);
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

// --- 6b: multi-profile subagent span matching ---

test("SUBAGENT-REQ-001: a tool name from a profile OTHER than gentle-pi (pi's reference example, tool 'subagent') opens a subagent span too, when that's the only registered profile for it", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [], [GENTLE_PI_PROFILE, PI_REFERENCE_PROFILE]);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "subagent", { agent: "researcher" });
  clock.advanceTo(500);
  tracker.onToolEnd("call-1", { details: { mode: "single" } });
  const record = tracker.onSettled();

  assert.equal(record?.subagents.length, 1);
  assert.equal(record?.subagents[0]?.agent, "researcher");
  assert.equal(record?.subagents[0]?.profile, "pi-reference");
});

test("SUBAGENT-REQ-005: when two profiles register the same tool name ('subagent'), the span still opens (best-effort agent/mode merge) but 'profile' is never guessed — left undefined", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock); // default: all 3 built-ins, including the pi-reference/pi-subagents collision on "subagent"

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "subagent", { agent: "researcher", action: "create" });
  clock.advanceTo(500);
  tracker.onToolEnd("call-1", {});
  const record = tracker.onSettled();

  assert.equal(record?.subagents.length, 1);
  assert.equal(record?.subagents[0]?.agent, "researcher");
  assert.equal(record?.subagents[0]?.profile, undefined);
});

test("a tool name matching no profile at all never opens a subagent span", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "bash", { command: "ls" });
  clock.advanceTo(100);
  tracker.onToolEnd("call-1", {});
  const record = tracker.onSettled();

  assert.deepEqual(record?.subagents, []);
});

// --- 6c/C1: SUBAGENT-REQ-006, usage forwarding (revised) ---
//
// C1 (CRITICAL fix): forwarded usage is no longer folded into the parent
// record's own `usage` totals at write time — it lives on the span as
// `forwardedUsage`, and `domain/task-view.ts#buildTasks` (ADR 0006) is the
// only place that later decides whether to add it to a task's aggregate
// total (never when a joined child with the same profile already carries
// it). The orchestrator record's own `usage` reflects only its own directly
// observed turns from here on.

test("SUBAGENT-REQ-006: a subagent tool result's usage is recorded on the span as forwardedUsage, never folded into the parent record's own usage totals", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [], [GENTLE_PI_PROFILE, PI_REFERENCE_PROFILE]);

  tracker.onRunStart("prompt");
  tracker.onTurnEnd({ input: 100, output: 50, cost: 0.01 });
  tracker.onToolStart("call-1", "subagent", { agent: "researcher" });
  clock.advanceTo(500);
  tracker.onToolEnd("call-1", { usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.002 } });
  const record = tracker.onSettled();

  // Only the real turn's own usage — the forwarded span usage is not here.
  assert.deepEqual(record?.usage, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
  assert.deepEqual(record?.subagents[0]?.forwardedUsage, { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.002 });
});

test("SUBAGENT-REQ-006: forwarded usage sets costObserved only when a finite cost figure accompanies it — matches onTurnEnd's own semantics (a forwarded usage without a cost figure is 'unknown', not 'measured')", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [], [GENTLE_PI_PROFILE, PI_REFERENCE_PROFILE]);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "subagent", {});
  clock.advanceTo(100);
  tracker.onToolEnd("call-1", { usage: { input: 5, output: 5 } }); // no cost field
  const record = tracker.onSettled();

  assert.equal(record?.costObserved, undefined);
  assert.equal(record?.usage.input, 0);
  assert.deepEqual(record?.subagents[0]?.forwardedUsage, { input: 5, output: 5 });
});

test("SUBAGENT-REQ-006/gentle-pi regression: gentle-pi's subagent_run result never carries usage, so no forwardedUsage is ever recorded on its span (verified: gentle-pi 3.3.0 never sets it)", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "subagent_run", { agent: "sdd-explore" });
  clock.advanceTo(100);
  tracker.onToolEnd("call-1", { details: { gentleAgents: { taskId: "t1" } }, usage: { input: 999, cost: 99 } });
  const record = tracker.onSettled();

  // gentle-pi's profile never reads usage off the result at all — even a
  // result that happens to carry one (should never occur in practice) is
  // ignored, since the profile's own readResult simply does not look at it.
  assert.deepEqual(record?.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  assert.equal(record?.costObserved, undefined);
  assert.equal(record?.subagents[0]?.forwardedUsage, undefined);
});

test("a repeated onToolEnd for the same toolCallId never double-adds forwarded usage (the open-span map entry is consumed exactly once, guarding double attribution)", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [], [GENTLE_PI_PROFILE, PI_REFERENCE_PROFILE]);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "subagent", {});
  clock.advanceTo(100);
  tracker.onToolEnd("call-1", { usage: { input: 10, cost: 0.01 } });
  // A duplicate event for the same tool call id (should never happen from a
  // well-behaved pi runtime, but must never be able to double-bill).
  tracker.onToolEnd("call-1", { usage: { input: 10, cost: 0.01 } });
  const record = tracker.onSettled();

  assert.equal(record?.subagents.length, 1);
  assert.deepEqual(record?.subagents[0]?.forwardedUsage, { input: 10, cost: 0.01 });
});

test("pi-subagents' profile never forwards usage even when its tool result happens to carry one — avoids double-counting an ancestry-joined child (see domain/subagent-profile.ts)", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [], [PI_SUBAGENTS_PROFILE]);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "subagent", { agent: "researcher", action: "create" });
  clock.advanceTo(100);
  tracker.onToolEnd("call-1", { usage: { input: 50, cost: 0.05 } });
  const record = tracker.onSettled();

  assert.deepEqual(record?.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  assert.equal(record?.subagents[0]?.forwardedUsage, undefined);
});

// --- C1 (CRITICAL fix): production-shaped ambiguity — every built-in
// profile active together (exactly how production always runs), the
// collision that actually caused the latent double count. ---

test("C1: an ambiguous 'subagent' call (pi-reference + pi-subagents both registered) with usage on the result never forwards it — span opens, but forwardedUsage stays undefined", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock); // default: all 3 built-ins — the real production shape

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "subagent", { agent: "researcher" });
  clock.advanceTo(500);
  tracker.onToolEnd("call-1", { usage: { input: 5000, output: 2000, cost: 1.23 } });
  const record = tracker.onSettled();

  assert.equal(record?.subagents.length, 1);
  assert.equal(record?.subagents[0]?.profile, undefined);
  assert.equal(record?.subagents[0]?.forwardedUsage, undefined);
  assert.deepEqual(record?.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  assert.equal(record?.costObserved, undefined);
});

test("C1: an UNAMBIGUOUS pi-reference call (pi-reference registered alone) with usage and no marker-confirmed child still forwards usage on the span exactly once", () => {
  const clock = new FakeClock(0);
  const tracker = makeTracker(clock, [], [GENTLE_PI_PROFILE, PI_REFERENCE_PROFILE]);

  tracker.onRunStart("prompt");
  tracker.onToolStart("call-1", "subagent", { agent: "researcher" });
  clock.advanceTo(500);
  tracker.onToolEnd("call-1", { usage: { input: 100, output: 40, cost: 0.03 } });
  const record = tracker.onSettled();

  assert.equal(record?.subagents[0]?.profile, "pi-reference");
  assert.deepEqual(record?.subagents[0]?.forwardedUsage, { input: 100, output: 40, cost: 0.03 });
});

test("a user prompt announced but never run does not swallow the next extension-started run", () => {
  const clock = new FakeClock(0);
  const tracker = new WorkTracker({ clock, interactiveTools: [], subagentProfiles: [] });
  tracker.onRunStart("cancelled before the loop started");
  clock.advanceTo(100);
  tracker.onSettled();

  clock.advanceTo(1000);
  tracker.onAgentStart();
  clock.advanceTo(4000);
  const record = tracker.onSettled();
  assert.equal(record?.trigger, "extension");
  assert.equal(record?.wallMs, 3000);
});

// --- A new run that starts BEFORE the previous one is settled ----------------
// pi clears its "run active" flag and only then awaits the agent_settled
// handlers, in extension load order. gentle-pi, loaded before kankaku, wakes
// the orchestrator from its own agent_settled handler — so the NEW run's
// agent_start reaches kankaku before kankaku has seen the OLD run's
// agent_settled. Found by independent review, 2026-09-21.

function splitTracker() {
  const clock = new FakeClock(0);
  return { clock, tracker: new WorkTracker({ clock, interactiveTools: [], subagentProfiles: [] }) };
}

test("a run that starts before the previous one settles becomes its OWN record; the old one ends where the new one began", () => {
  const { clock, tracker } = splitTracker();
  tracker.onRunStart("user prompt");
  tracker.onAgentStart();
  clock.advanceTo(1000);
  tracker.onTurnEnd({ cost: 1 });
  tracker.onRunEnd([]);

  clock.advanceTo(1200);
  tracker.onAgentStart(); // the extension-started run, ahead of the settle
  clock.advanceTo(1300);
  const first = tracker.settleAll(); // the OLD run's agent_settled finally arrives

  assert.equal(first.length, 1);
  assert.equal(first[0]!.prompt, "user prompt");
  assert.equal(first[0]!.runs, 1);
  assert.equal(first[0]!.wallMs, 1200);
  assert.equal(first[0]!.usage.cost, 1);
  assert.notEqual(tracker.peek("interrupted"), undefined, "the new run must still be open");

  clock.advanceTo(9000);
  tracker.onTurnEnd({ cost: 4 });
  tracker.onRunEnd([]);
  clock.advanceTo(9100);
  const second = tracker.settleAll();

  assert.equal(second.length, 1);
  assert.equal(second[0]!.trigger, "extension");
  assert.equal(second[0]!.wallMs, 7900); // 1200 → 9100
  assert.equal(second[0]!.usage.cost, 4);
  assert.notEqual(second[0]!.id, first[0]!.id);
});

test("an agent.continue() retry inside the same run (agent_end, agent_start, agent_end, THEN settled) stays ONE record with everything in it", () => {
  const { clock, tracker } = splitTracker();
  tracker.onRunStart("user prompt");
  tracker.onAgentStart();
  clock.advanceTo(1000);
  tracker.onTurnEnd({ cost: 1 });
  tracker.onRunEnd([]);
  tracker.onAgentStart(); // continuation: retry / queued follow-up
  clock.advanceTo(3000);
  tracker.onTurnEnd({ cost: 2 });
  tracker.onToolStart("t1", "read", {});
  tracker.onToolEnd("t1", {});
  tracker.onRunEnd([]);
  clock.advanceTo(3100);
  const records = tracker.settleAll();

  assert.equal(records.length, 1);
  assert.equal(records[0]!.prompt, "user prompt");
  assert.equal(records[0]!.trigger, undefined);
  assert.equal(records[0]!.wallMs, 3100);
  assert.equal(records[0]!.usage.cost, 3);
  assert.equal(records[0]!.turns, 2);
  assert.equal(records[0]!.runs, 2);
  assert.deepEqual(records[0]!.tools, { read: 1 });
});

test("a USER prompt that races ahead of the previous settle keeps its own prompt text in its own record", () => {
  const { clock, tracker } = splitTracker();
  tracker.onRunStart("first");
  tracker.onAgentStart();
  clock.advanceTo(1000);
  tracker.onRunEnd([]);
  clock.advanceTo(1100);
  tracker.onRunStart("second");
  tracker.onAgentStart();
  const first = tracker.settleAll();
  assert.deepEqual(first.map((r) => r.prompt), ["first"]);
  clock.advanceTo(2000);
  tracker.onRunEnd([]);
  const second = tracker.settleAll();
  assert.deepEqual(second.map((r) => [r.prompt, r.trigger, r.wallMs]), [["second", undefined, 900]]);
});

test("shutdown while a split is pending loses neither record", () => {
  const { clock, tracker } = splitTracker();
  tracker.onRunStart("first");
  tracker.onAgentStart();
  clock.advanceTo(1000);
  tracker.onRunEnd([]);
  tracker.onAgentStart();
  clock.advanceTo(5000);
  const records = tracker.shutdownAll();
  assert.deepEqual(records.map((r) => [r.prompt === "first", r.status, r.wallMs]), [[true, "completed", 1000], [false, "interrupted", 4000]]);
});

test("crash safety: while a record is set aside, the checkpoint (peek) still carries ITS cost — continuation case", () => {
  const { clock, tracker } = splitTracker();
  tracker.onRunStart("user prompt");
  tracker.onAgentStart();
  clock.advanceTo(1000);
  tracker.onTurnEnd({ cost: 1 });
  tracker.onRunEnd([]);
  tracker.onAgentStart(); // pi's auto-retry
  clock.advanceTo(2000);
  tracker.onTurnEnd({ cost: 2 });

  const checkpoint = tracker.peek("interrupted")!;
  assert.equal(checkpoint.usage.cost, 3);
  assert.equal(checkpoint.prompt, "user prompt");
  assert.equal(checkpoint.wallMs, 2000);
});

test("crash safety: the checkpoint id is the set-aside record's id, so a recovered copy can be told apart from the settled one", () => {
  const { clock, tracker } = splitTracker();
  tracker.onRunStart("user prompt");
  tracker.onAgentStart();
  const firstId = tracker.peek("interrupted")!.id;
  clock.advanceTo(1000);
  tracker.onRunEnd([]);
  tracker.onAgentStart();
  assert.equal(tracker.peek("interrupted")!.id, firstId);
  const [old] = tracker.settleAll();
  assert.equal(old!.id, firstId);
  assert.notEqual(tracker.peek("interrupted")!.id, firstId, "once the old record is written, the checkpoint is the new run alone");
});
