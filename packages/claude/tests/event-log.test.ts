import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEventLog, dropSettledPrompts } from "../src/event-log.ts";
import type { Event } from "../src/events.ts";

test("appendEvent creates parent directories and appends one JSON line", () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-eventlog-"));
  try {
    const file = join(dir, "sub", "s1.events.jsonl");
    appendEvent(file, { ts: 1, event: "UserPromptSubmit", prompt: "hi" });
    appendEvent(file, { ts: 2, event: "Stop", stopHookActive: false });
    const text = readFileSync(file, "utf8");
    assert.equal(text.split("\n").filter(Boolean).length, 2);
    assert.deepEqual(readEventLog(file), [
      { ts: 1, event: "UserPromptSubmit", prompt: "hi" },
      { ts: 2, event: "Stop", stopHookActive: false },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEventLog returns an empty array when the file does not exist", () => {
  assert.deepEqual(readEventLog(join(tmpdir(), "kankaku-claude-missing.jsonl")), []);
});

test("readEventLog tolerates a truncated last line", () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-eventlog-"));
  try {
    const file = join(dir, "s1.events.jsonl");
    writeFileSync(file, '{"ts":1,"event":"Stop","stopHookActive":false}\n{"ts":2,"event":"Sto');
    assert.equal(readEventLog(file).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dropSettledPrompts rewrites the file atomically with only the kept events", () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-eventlog-"));
  try {
    const file = join(dir, "s1.events.jsonl");
    appendEvent(file, { ts: 1, event: "UserPromptSubmit", prompt: "one" });
    appendEvent(file, { ts: 2, event: "Stop", stopHookActive: false });
    appendEvent(file, { ts: 3, event: "UserPromptSubmit", prompt: "two" });
    const keep: Event[] = [{ ts: 3, event: "UserPromptSubmit", prompt: "two" }];
    dropSettledPrompts(file, keep);
    assert.deepEqual(readEventLog(file), keep);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dropSettledPrompts can empty the file (nothing to keep)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-eventlog-"));
  try {
    const file = join(dir, "s1.events.jsonl");
    mkdirSync(dir, { recursive: true });
    appendEvent(file, { ts: 1, event: "UserPromptSubmit", prompt: "one" });
    dropSettledPrompts(file, []);
    assert.deepEqual(readEventLog(file), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
