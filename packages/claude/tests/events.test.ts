import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serializeEvent,
  parseEventLine,
  readEvents,
  type Event,
} from "../src/events.ts";

test("serializeEvent produces one JSON line that round-trips through parseEventLine", () => {
  const event: Event = {
    ts: 1000,
    event: "UserPromptSubmit",
    prompt: "hello",
    promptId: "p1",
  };
  const line = serializeEvent(event);
  assert.equal(typeof line, "string");
  assert.equal(line.includes("\n"), false);
  assert.deepEqual(parseEventLine(line), event);
});

test("parseEventLine accepts every documented event shape", () => {
  const samples: Event[] = [
    { ts: 1, event: "UserPromptSubmit", prompt: "hi" },
    {
      ts: 2,
      event: "PreToolUse",
      toolUseId: "t1",
      toolName: "Read",
      toolInput: { path: "/x" },
    },
    { ts: 3, event: "PostToolUse", toolUseId: "t1", toolName: "Read" },
    {
      ts: 4,
      event: "PermissionRequest",
      toolUseId: "t2",
      toolName: "Bash",
    },
    { ts: 5, event: "SubagentStart", agentId: "a1", agentType: "explore" },
    { ts: 6, event: "SubagentStop", agentId: "a1", agentType: "explore" },
    { ts: 7, event: "Stop", stopHookActive: false },
    { ts: 8, event: "SessionStart", source: "startup" },
    { ts: 9, event: "SessionEnd", reason: "exit" },
  ];
  for (const sample of samples) {
    assert.deepEqual(parseEventLine(serializeEvent(sample)), sample);
  }
});

test("parseEventLine returns undefined for malformed JSON, never throws", () => {
  assert.equal(parseEventLine("not json"), undefined);
  assert.equal(parseEventLine("{unterminated"), undefined);
  assert.equal(parseEventLine(""), undefined);
});

test("parseEventLine returns undefined for unknown event names", () => {
  assert.equal(
    parseEventLine(JSON.stringify({ ts: 1, event: "Bogus" })),
    undefined,
  );
});

test("parseEventLine returns undefined when required fields are missing or wrong-typed", () => {
  assert.equal(
    parseEventLine(JSON.stringify({ ts: 1, event: "UserPromptSubmit" })),
    undefined,
  );
  assert.equal(
    parseEventLine(
      JSON.stringify({ ts: "not-a-number", event: "UserPromptSubmit", prompt: "hi" }),
    ),
    undefined,
  );
  assert.equal(
    parseEventLine(JSON.stringify({ event: "Stop", stopHookActive: false })),
    undefined,
  );
});

test("readEvents parses each line and skips a truncated last line", () => {
  const lines = [
    serializeEvent({ ts: 1, event: "UserPromptSubmit", prompt: "hi" }),
    serializeEvent({ ts: 2, event: "Stop", stopHookActive: false }),
  ];
  const truncated = '{"ts":3,"event":"Preto';
  const text = lines.join("\n") + "\n" + truncated;
  const events = readEvents(text);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.event, "UserPromptSubmit");
  assert.equal(events[1]?.event, "Stop");
});

test("readEvents tolerates blank lines and an empty file", () => {
  assert.deepEqual(readEvents(""), []);
  assert.deepEqual(readEvents("\n\n"), []);
});
