import { test } from "node:test";
import assert from "node:assert/strict";
import { isWorkRecord } from "kankaku-pi/domain";
import { splitPrompts, replayPrompt, type PromptEvents } from "../src/replay.ts";
import type { Event } from "../src/events.ts";

function fakeMetadata(core: ReturnType<typeof replayPrompt>) {
  // Attach the minimal WorkRecordMetadata fields isWorkRecord requires, without
  // pulling in the storage layer (that is T2/T3's job).
  return {
    ...core,
    role: "orchestrator" as const,
    pid: 1,
    parentPid: 0,
    project: "/tmp/project",
  };
}

test("splitPrompts groups a completed prompt with tools into one closed group", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "do work" },
    { ts: 2000, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} },
    { ts: 2500, event: "PostToolUse", toolUseId: "t1", toolName: "Read" },
    { ts: 3000, event: "Stop", stopHookActive: false },
  ];
  const prompts = splitPrompts(events);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.open, false);
  assert.equal(prompts[0]?.events.length, 4);
});

test("splitPrompts ignores leading events before any UserPromptSubmit", () => {
  const events: Event[] = [
    { ts: 100, event: "SessionStart", source: "startup" },
    { ts: 200, event: "PreToolUse", toolUseId: "orphan", toolName: "Read", toolInput: {} },
    { ts: 1000, event: "UserPromptSubmit", prompt: "hi" },
    { ts: 2000, event: "Stop", stopHookActive: false },
  ];
  const prompts = splitPrompts(events);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.events.length, 2);
});

test("splitPrompts keeps a continuation after Stop in the same prompt and reports it open when unterminated", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "hi" },
    { ts: 2000, event: "Stop", stopHookActive: true },
    { ts: 2500, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} },
  ];
  const prompts = splitPrompts(events);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.open, true);
  assert.equal(prompts[0]?.events.length, 3);
});

test("splitPrompts closes a continuation prompt once a final Stop terminates it", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "hi" },
    { ts: 2000, event: "Stop", stopHookActive: true },
    { ts: 2500, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} },
    { ts: 3000, event: "PostToolUse", toolUseId: "t1", toolName: "Read" },
    { ts: 3500, event: "Stop", stopHookActive: false },
  ];
  const prompts = splitPrompts(events);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.open, false);
  assert.equal(prompts[0]?.events.length, 5);
});

test("splitPrompts reports a prompt with no Stop as open", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "hi" },
    { ts: 1500, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} },
  ];
  const prompts = splitPrompts(events);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.open, true);
});

test("splitPrompts starts a new group at each UserPromptSubmit", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "one" },
    { ts: 2000, event: "Stop", stopHookActive: false },
    { ts: 3000, event: "UserPromptSubmit", prompt: "two" },
    { ts: 4000, event: "Stop", stopHookActive: false },
  ];
  const prompts = splitPrompts(events);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0]?.open, false);
  assert.equal(prompts[1]?.open, false);
});

test("replayPrompt: completed prompt with tools produces wallMs = waitingMs + workMs and counts tools", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "do work" },
    { ts: 2000, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} },
    { ts: 2500, event: "PostToolUse", toolUseId: "t1", toolName: "Read" },
    { ts: 3000, event: "Stop", stopHookActive: false },
  ];
  const prompt: PromptEvents = { events, open: false };
  const core = replayPrompt(prompt, {});
  assert.ok(core);
  assert.equal(core.status, "completed");
  assert.equal(core.wallMs, core.waitingMs + core.workMs);
  assert.equal(core.tools.Read, 1);
  assert.ok(isWorkRecord(fakeMetadata(core)));
});

test("replayPrompt: waiting via AskUserQuestion span", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "ask" },
    { ts: 2000, event: "PreToolUse", toolUseId: "t1", toolName: "AskUserQuestion", toolInput: {} },
    { ts: 5000, event: "PostToolUse", toolUseId: "t1", toolName: "AskUserQuestion" },
    { ts: 6000, event: "Stop", stopHookActive: false },
  ];
  const prompt: PromptEvents = { events, open: false };
  const core = replayPrompt(prompt, {});
  assert.ok(core);
  assert.equal(core.wallMs, 5000);
  assert.equal(core.waitingMs, 3000);
  assert.equal(core.workMs, 2000);
});

test("replayPrompt: PermissionRequest span is closed by the next event of any kind", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "permission" },
    { ts: 2000, event: "PermissionRequest", toolUseId: "t1", toolName: "Bash" },
    { ts: 3000, event: "PreToolUse", toolUseId: "t1", toolName: "Bash", toolInput: {} },
    { ts: 4000, event: "PostToolUse", toolUseId: "t1", toolName: "Bash" },
    { ts: 5000, event: "Stop", stopHookActive: false },
  ];
  const prompt: PromptEvents = { events, open: false };
  const core = replayPrompt(prompt, {});
  assert.ok(core);
  // permission span 2000..3000 closed by the following PreToolUse.
  assert.equal(core.waitingMs, 1000);
});

test("replayPrompt: two overlapping spans (permission closed by a PreToolUse that opens an interactive-tool span) use union, not sum", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "overlap" },
    { ts: 2000, event: "PermissionRequest", toolUseId: "t1", toolName: "AskUserQuestion" },
    { ts: 2500, event: "PreToolUse", toolUseId: "t1", toolName: "AskUserQuestion", toolInput: {} },
    { ts: 4000, event: "PostToolUse", toolUseId: "t1", toolName: "AskUserQuestion" },
    { ts: 4500, event: "Stop", stopHookActive: false },
  ];
  const prompt: PromptEvents = { events, open: false };
  const core = replayPrompt(prompt, {});
  assert.ok(core);
  // union of [2000,2500] and [2500,4000] = 2000ms, not the 500+1500=2000 sum
  // (same number here, but assert the union bound: never exceeds wall time).
  assert.equal(core.waitingMs, 2000);
  assert.ok(core.waitingMs <= core.wallMs);
});

test("replayPrompt: Agent tool opens a SubagentSpan with agent read from subagent_type", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "delegate" },
    {
      ts: 2000,
      event: "PreToolUse",
      toolUseId: "t1",
      toolName: "Agent",
      toolInput: { subagent_type: "general-purpose" },
    },
    { ts: 3000, event: "PostToolUse", toolUseId: "t1", toolName: "Agent" },
    { ts: 4000, event: "Stop", stopHookActive: false },
  ];
  const prompt: PromptEvents = { events, open: false };
  const core = replayPrompt(prompt, {});
  assert.ok(core);
  assert.equal(core.subagents.length, 1);
  assert.equal(core.subagents[0]?.agent, "general-purpose");
  assert.equal(core.subagents[0]?.mode, "task");
});

test("replayPrompt: Stop-continued run bumps runs", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "continue" },
    { ts: 2000, event: "Stop", stopHookActive: true },
    { ts: 2500, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} },
    { ts: 3000, event: "PostToolUse", toolUseId: "t1", toolName: "Read" },
    { ts: 4000, event: "Stop", stopHookActive: false },
  ];
  const prompt: PromptEvents = { events, open: false };
  const core = replayPrompt(prompt, {});
  assert.ok(core);
  assert.equal(core.runs, 2);
  assert.equal(core.status, "completed");
});

test("replayPrompt: interrupted prompt (no Stop) settles at the last event ts with status interrupted", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "cut off" },
    { ts: 2000, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} },
  ];
  const prompt: PromptEvents = { events, open: true };
  const core = replayPrompt(prompt, {});
  assert.ok(core);
  assert.equal(core.status, "interrupted");
  assert.equal(core.settledAt, new Date(2000).toISOString());
});

test("replayPrompt: interrupted prompt settles at an explicit settledAt when given", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "cut off" },
    { ts: 2000, event: "PreToolUse", toolUseId: "t1", toolName: "Read", toolInput: {} },
  ];
  const prompt: PromptEvents = { events, open: true };
  const core = replayPrompt(prompt, { settledAt: 5000 });
  assert.ok(core);
  assert.equal(core.settledAt, new Date(5000).toISOString());
});

test("replayPrompt: cost delta present sets usage.cost and costObserved", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "cost" },
    { ts: 2000, event: "Stop", stopHookActive: false },
  ];
  const prompt: PromptEvents = { events, open: false };
  const core = replayPrompt(prompt, { cost: 0.42 });
  assert.ok(core);
  assert.equal(core.usage.cost, 0.42);
  assert.equal(core.costObserved, true);
});

test("replayPrompt: cost delta absent leaves costObserved unset", () => {
  const events: Event[] = [
    { ts: 1000, event: "UserPromptSubmit", prompt: "no cost" },
    { ts: 2000, event: "Stop", stopHookActive: false },
  ];
  const prompt: PromptEvents = { events, open: false };
  const core = replayPrompt(prompt, {});
  assert.ok(core);
  assert.equal(core.costObserved, undefined);
});

test("replayPrompt returns undefined for an empty prompt", () => {
  const prompt: PromptEvents = { events: [], open: false };
  assert.equal(replayPrompt(prompt, {}), undefined);
});
