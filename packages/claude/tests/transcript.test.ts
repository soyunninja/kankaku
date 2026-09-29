import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscriptChunk, readTranscriptSince, readTranscriptHead, listSubagentTranscripts } from "../src/transcript.ts";

// Synthetic lines that copy only the SHAPES of a Claude Code transcript.
function assistant(id: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "assistant", message: { id, model: "model-x", usage }, ...extra });
}

function usage(input: number, output: number, cacheRead: number, cacheCreation: number): Record<string, unknown> {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

function lines(...items: string[]): string {
  return items.map((item) => `${item}\n`).join("");
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

test("parseTranscriptChunk maps the four usage fields", () => {
  const result = parseTranscriptChunk(lines(assistant("m1", usage(1, 2, 3, 4))), {});
  assert.deepEqual(result.usage, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.equal(result.lastMessageId, "m1");
});

test("parseTranscriptChunk counts each message.id once within the chunk", () => {
  const result = parseTranscriptChunk(
    lines(assistant("m1", usage(1, 1, 1, 1)), assistant("m1", usage(1, 1, 1, 1)), assistant("m2", usage(10, 0, 0, 0)), assistant("m2", usage(10, 0, 0, 0))),
    {},
  );
  assert.deepEqual(result.usage, { input: 11, output: 1, cacheRead: 1, cacheWrite: 1 });
  assert.equal(result.lastMessageId, "m2");
});

test("parseTranscriptChunk skips lines that repeat lastMessageId and keeps it when nothing else is counted", () => {
  const repeat = parseTranscriptChunk(lines(assistant("m1", usage(5, 5, 5, 5))), { lastMessageId: "m1" });
  assert.deepEqual(repeat.usage, ZERO);
  assert.equal(repeat.lastMessageId, "m1");

  const mixed = parseTranscriptChunk(lines(assistant("m1", usage(5, 5, 5, 5)), assistant("m2", usage(1, 0, 0, 0))), { lastMessageId: "m1" });
  assert.deepEqual(mixed.usage, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(mixed.lastMessageId, "m2");
});

test("parseTranscriptChunk ignores blank lines, non-JSON, other types and assistant lines without a message id", () => {
  const text = [
    "",
    "not json at all",
    "{\"type\":\"assistant\",",
    JSON.stringify({ type: "user", message: { id: "u1", usage: usage(9, 9, 9, 9) } }),
    JSON.stringify({ type: "assistant", message: { usage: usage(9, 9, 9, 9) } }),
    JSON.stringify({ type: "assistant" }),
    JSON.stringify([1, 2, 3]),
    "null",
    assistant("m1", usage(1, 1, 1, 1)),
  ].join("\n");
  const result = parseTranscriptChunk(text, {});
  assert.deepEqual(result.usage, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
});

test("parseTranscriptChunk ignores non-finite, negative and non-numeric values field by field", () => {
  const text = lines(
    // 1e999 parses to Infinity in JSON.parse.
    `{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":1e999,"output_tokens":-4,"cache_read_input_tokens":"7","cache_creation_input_tokens":3}}}`,
    assistant("m2", { input_tokens: 2 }),
    assistant("m3", null as unknown as Record<string, unknown>),
  );
  const result = parseTranscriptChunk(text, {});
  assert.deepEqual(result.usage, { input: 2, output: 0, cacheRead: 0, cacheWrite: 3 });
});

test("parseTranscriptChunk reads version and entrypoint from the first line that carries them", () => {
  const text = lines(
    JSON.stringify({ type: "system", note: "no metadata here" }),
    JSON.stringify({ type: "user", version: "1.2.3", entrypoint: "sdk-cli" }),
    assistant("m1", usage(1, 1, 1, 1), { version: "9.9.9", entrypoint: "cli" }),
  );
  const result = parseTranscriptChunk(text, {});
  assert.equal(result.version, "1.2.3");
  assert.equal(result.entrypoint, "sdk-cli");
  assert.equal(parseTranscriptChunk(lines(assistant("m1", usage(1, 1, 1, 1))), {}).version, undefined);
  assert.equal(parseTranscriptChunk(lines(JSON.stringify({ type: "user", version: 3, entrypoint: "" })), {}).version, undefined);
  assert.equal(parseTranscriptChunk(lines(JSON.stringify({ type: "user", version: 3, entrypoint: "" })), {}).entrypoint, undefined);
});

test("parseTranscriptChunk keeps the last valid cost-state", () => {
  const cost = (total: unknown, unknown_?: unknown) =>
    JSON.stringify({ type: "cost-state", totalCostUSD: total, hasUnknownModelCost: unknown_, modelUsage: { "model-x": { costUSD: 1 } } });
  const result = parseTranscriptChunk(lines(cost(0.5, false), cost(1.25, true), cost(-1), cost("2"), cost(null)), {});
  assert.deepEqual(result.costState, { totalUsd: 1.25, hasUnknownModelCost: true });

  const noFlag = parseTranscriptChunk(lines(cost(0.75)), {});
  assert.deepEqual(noFlag.costState, { totalUsd: 0.75, hasUnknownModelCost: false });

  assert.equal(parseTranscriptChunk(lines(assistant("m1", usage(1, 1, 1, 1))), {}).costState, undefined);
});

test("parseTranscriptChunk of an empty chunk is zero and passes lastMessageId through", () => {
  const result = parseTranscriptChunk("", { lastMessageId: "m9" });
  assert.deepEqual(result.usage, ZERO);
  assert.equal(result.lastMessageId, "m9");
  assert.equal(parseTranscriptChunk("", {}).lastMessageId, undefined);
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-transcript-"));
}

test("readTranscriptSince reads from the stored offset and advances the position", () => {
  const dir = tmp();
  try {
    const file = join(dir, "s.jsonl");
    const first = lines(assistant("m1", usage(1, 1, 1, 1)));
    writeFileSync(file, first);

    const a = readTranscriptSince(file, { bytes: 0 });
    assert.deepEqual(a.usage, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
    assert.equal(a.position.bytes, Buffer.byteLength(first));
    assert.equal(a.position.lastMessageId, "m1");
    assert.equal(a.truncated, false);

    appendFileSync(file, lines(assistant("m2", usage(2, 0, 0, 0))));
    const b = readTranscriptSince(file, a.position);
    assert.deepEqual(b.usage, { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(b.position.lastMessageId, "m2");

    const c = readTranscriptSince(file, b.position);
    assert.deepEqual(c.usage, ZERO);
    assert.deepEqual(c.position, b.position);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTranscriptSince leaves a trailing partial line for the next read", () => {
  const dir = tmp();
  try {
    const file = join(dir, "s.jsonl");
    const whole = lines(assistant("m1", usage(1, 1, 1, 1)));
    const partial = assistant("m2", usage(4, 4, 4, 4));
    writeFileSync(file, whole + partial.slice(0, 20));

    const a = readTranscriptSince(file, { bytes: 0 });
    assert.equal(a.usage.input, 1);
    assert.equal(a.position.bytes, Buffer.byteLength(whole));

    appendFileSync(file, `${partial.slice(20)}\n`);
    const b = readTranscriptSince(file, a.position);
    assert.deepEqual(b.usage, { input: 4, output: 4, cacheRead: 4, cacheWrite: 4 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTranscriptSince does not double count a message id split across two reads", () => {
  const dir = tmp();
  try {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, lines(assistant("m1", usage(1, 1, 1, 1))));
    const a = readTranscriptSince(file, { bytes: 0 });
    appendFileSync(file, lines(assistant("m1", usage(1, 1, 1, 1)), assistant("m2", usage(0, 3, 0, 0))));
    const b = readTranscriptSince(file, a.position);
    assert.deepEqual(b.usage, { input: 0, output: 3, cacheRead: 0, cacheWrite: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTranscriptSince keeps byte offsets right across multibyte characters", () => {
  const dir = tmp();
  try {
    const file = join(dir, "s.jsonl");
    const first = lines(JSON.stringify({ type: "user", note: "ñandú ✓" }), assistant("m1", usage(1, 0, 0, 0)));
    writeFileSync(file, first);
    const a = readTranscriptSince(file, { bytes: 0 });
    assert.equal(a.position.bytes, Buffer.byteLength(first));
    appendFileSync(file, lines(assistant("m2", usage(2, 0, 0, 0))));
    assert.equal(readTranscriptSince(file, a.position).usage.input, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTranscriptSince on a missing or unreadable path returns zero usage and the same position", () => {
  const dir = tmp();
  try {
    const position = { bytes: 42, lastMessageId: "m7" };
    const missing = readTranscriptSince(join(dir, "nope.jsonl"), position);
    assert.deepEqual(missing.usage, ZERO);
    assert.deepEqual(missing.position, position);
    assert.equal(missing.truncated, false);

    const isDir = readTranscriptSince(dir, position);
    assert.deepEqual(isDir.usage, ZERO);
    assert.deepEqual(isDir.position, position);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTranscriptSince restarts from 0 when the file is shorter than the stored position", () => {
  const dir = tmp();
  try {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, lines(assistant("m1", usage(3, 0, 0, 0))));
    const result = readTranscriptSince(file, { bytes: 100000, lastMessageId: "m1" });
    // The stale lastMessageId must not swallow the replaced file's first message.
    assert.equal(result.usage.input, 3);
    assert.equal(result.position.bytes, Buffer.byteLength(lines(assistant("m1", usage(3, 0, 0, 0)))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTranscriptSince beyond the byte bound counts nothing, jumps to the end and flags truncated", () => {
  const dir = tmp();
  try {
    const file = join(dir, "s.jsonl");
    const body = lines(assistant("m1", usage(1, 1, 1, 1)), assistant("m2", usage(1, 1, 1, 1)));
    writeFileSync(file, body);
    const result = readTranscriptSince(file, { bytes: 0 }, { maxBytes: 10 });
    assert.deepEqual(result.usage, ZERO);
    assert.equal(result.truncated, true);
    assert.equal(result.position.bytes, Buffer.byteLength(body));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTranscriptSince reports version, entrypoint and cost-state from the bytes it read", () => {
  const dir = tmp();
  try {
    const file = join(dir, "s.jsonl");
    writeFileSync(
      file,
      lines(
        JSON.stringify({ type: "user", version: "2.0.0", entrypoint: "sdk-cli" }),
        JSON.stringify({ type: "cost-state", totalCostUSD: 0.5, modelUsage: {}, hasUnknownModelCost: false }),
      ),
    );
    const result = readTranscriptSince(file, { bytes: 0 });
    assert.equal(result.version, "2.0.0");
    assert.equal(result.entrypoint, "sdk-cli");
    assert.deepEqual(result.costState, { totalUsd: 0.5, hasUnknownModelCost: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSubagentTranscripts lists only the .jsonl files under <session>/subagents", () => {
  const dir = tmp();
  try {
    const session = join(dir, "abc.jsonl");
    writeFileSync(session, "");
    const sub = join(dir, "abc", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-b.jsonl"), "");
    writeFileSync(join(sub, "agent-a.jsonl"), "");
    writeFileSync(join(sub, "agent-a.json"), "{}");
    writeFileSync(join(sub, "notes.txt"), "");
    mkdirSync(join(sub, "nested.jsonl"));
    mkdirSync(join(dir, "other", "subagents"), { recursive: true });
    writeFileSync(join(dir, "other", "subagents", "x.jsonl"), "");

    assert.deepEqual(listSubagentTranscripts(session), [join(sub, "agent-a.jsonl"), join(sub, "agent-b.jsonl")]);
    assert.deepEqual(listSubagentTranscripts(join(dir, "missing.jsonl")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- last line of a message wins; messages straddling two reads ----

test("parseTranscriptChunk counts a message by its LAST line", () => {
  const result = parseTranscriptChunk(
    lines(assistant("m1", usage(5, 10, 7, 1)), assistant("m1", usage(5, 40, 7, 1)), assistant("m1", usage(5, 90, 7, 3))),
    {},
  );
  assert.deepEqual(result.usage, { input: 5, output: 90, cacheRead: 7, cacheWrite: 3 });
  assert.equal(result.lastMessageId, "m1");
  assert.deepEqual(result.lastMessageUsage, { input: 5, output: 90, cacheRead: 7, cacheWrite: 3 });
});

test("parseTranscriptChunk with interleaved messages does not crash and the last line per id wins", () => {
  const result = parseTranscriptChunk(
    lines(assistant("a", usage(1, 1, 0, 0)), assistant("b", usage(2, 2, 0, 0)), assistant("a", usage(1, 5, 0, 0)), assistant("b", usage(2, 9, 0, 0))),
    {},
  );
  assert.deepEqual(result.usage, { input: 3, output: 14, cacheRead: 0, cacheWrite: 0 });
  assert.equal(result.lastMessageId, "b");
});

test("parseTranscriptChunk keeps the last line that has a usage object when a later line of the id has none", () => {
  const noUsage = JSON.stringify({ type: "assistant", message: { id: "m1" } });
  const result = parseTranscriptChunk(lines(assistant("m1", usage(1, 8, 0, 0)), noUsage), {});
  assert.deepEqual(result.usage, { input: 1, output: 8, cacheRead: 0, cacheWrite: 0 });
});

test("a message continued in the next chunk adds only the difference, per field", () => {
  const previous = { lastMessageId: "m1", lastMessageUsage: { input: 5, output: 10, cacheRead: 7, cacheWrite: 1 } };
  const result = parseTranscriptChunk(lines(assistant("m1", usage(5, 30, 7, 4))), previous);
  assert.deepEqual(result.usage, { input: 0, output: 20, cacheRead: 0, cacheWrite: 3 });
  assert.equal(result.lastMessageId, "m1");
  assert.deepEqual(result.lastMessageUsage, { input: 5, output: 30, cacheRead: 7, cacheWrite: 4 });
});

test("a chunk starting with a different id subtracts nothing", () => {
  const previous = { lastMessageId: "m1", lastMessageUsage: { input: 5, output: 10, cacheRead: 7, cacheWrite: 1 } };
  const result = parseTranscriptChunk(lines(assistant("m2", usage(1, 2, 3, 4))), previous);
  assert.deepEqual(result.usage, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.equal(result.lastMessageId, "m2");
  assert.deepEqual(result.lastMessageUsage, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
});

test("a stored usage larger than the new one contributes 0, never a negative number", () => {
  const previous = { lastMessageId: "m1", lastMessageUsage: { input: 9, output: 50, cacheRead: 7, cacheWrite: 1 } };
  const result = parseTranscriptChunk(lines(assistant("m1", usage(5, 30, 7, 4))), previous);
  assert.deepEqual(result.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 3 });
  assert.deepEqual(result.lastMessageUsage, { input: 9, output: 50, cacheRead: 7, cacheWrite: 4 });
});

test("a legacy position (id without counted usage) skips the head lines of that id and stays legacy", () => {
  const result = parseTranscriptChunk(lines(assistant("m1", usage(5, 30, 7, 4)), assistant("m1", usage(5, 40, 7, 4))), { lastMessageId: "m1" });
  assert.deepEqual(result.usage, ZERO);
  assert.equal(result.lastMessageId, "m1");
  assert.equal(result.lastMessageUsage, undefined);

  const next = parseTranscriptChunk(lines(assistant("m1", usage(5, 50, 7, 4)), assistant("m2", usage(1, 1, 0, 0))), { lastMessageId: "m1" });
  assert.deepEqual(next.usage, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(next.lastMessageUsage, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
});

test("readTranscriptSince stores the counted usage and adds only the difference when a message straddles two reads", () => {
  const dir = tmp();
  try {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, lines(assistant("m1", usage(1, 10, 0, 0))));
    const a = readTranscriptSince(file, { bytes: 0 });
    assert.deepEqual(a.position.lastMessageUsage, { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 });
    appendFileSync(file, lines(assistant("m1", usage(1, 25, 0, 0))));
    const b = readTranscriptSince(file, a.position);
    assert.deepEqual(b.usage, { input: 0, output: 15, cacheRead: 0, cacheWrite: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("conservation: reading a growing subagent-like transcript in any slices sums to the last line of every message", () => {
  const dir = tmp();
  try {
    const file = join(dir, "s.jsonl");
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = prng(seed);
      const int = (max: number) => Math.floor(rnd() * max);
      const expected = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let text = "";
      const count = 3 + int(12);
      for (let m = 0; m < count; m++) {
        let u = { input: int(5), output: int(20), cacheRead: int(50), cacheWrite: int(9) };
        const repeats = 1 + int(4);
        for (let r = 0; r < repeats; r++) {
          if (r > 0) u = { ...u, output: u.output + int(30), cacheWrite: u.cacheWrite + int(3) };
          text += lines(assistant(`msg-${seed}-${m}`, usage(u.input, u.output, u.cacheRead, u.cacheWrite)));
          if (rnd() < 0.3) text += `${JSON.stringify({ type: "user", note: "ñ" })}\n`;
        }
        expected.input += u.input;
        expected.output += u.output;
        expected.cacheRead += u.cacheRead;
        expected.cacheWrite += u.cacheWrite;
      }
      const bytes = Buffer.from(text);
      const cuts = Array.from({ length: 1 + int(8) }, () => int(bytes.length)).sort((x, y) => x - y);
      const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let position: { bytes: number; lastMessageId?: string; lastMessageUsage?: typeof sum } = { bytes: 0 };
      for (const cut of [...cuts, bytes.length]) {
        writeFileSync(file, bytes.subarray(0, cut));
        const read = readTranscriptSince(file, position);
        sum.input += read.usage.input;
        sum.output += read.usage.output;
        sum.cacheRead += read.usage.cacheRead;
        sum.cacheWrite += read.usage.cacheWrite;
        position = read.position;
      }
      assert.deepEqual(sum, expected, `cut pattern with seed ${seed}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseTranscriptChunk reports the model of the last assistant line", () => {
  const withModel = (id: string, model: unknown) =>
    JSON.stringify({ type: "assistant", message: { id, model, usage: usage(1, 1, 1, 1) } });
  assert.equal(parseTranscriptChunk(lines(withModel("a", "model-a"), withModel("b", "model-b")), {}).model, "model-b");
  assert.equal(parseTranscriptChunk(lines(withModel("a", "model-a"), withModel("b", 7)), {}).model, "model-a");
  assert.equal(parseTranscriptChunk(lines(assistant("a", usage(1, 1, 1, 1))), {}).model, "model-x");
  assert.equal(parseTranscriptChunk(lines(JSON.stringify({ type: "user" })), {}).model, undefined);
});

test("a finite cost-state total is usable whatever modelUsage holds, unless it flags an unknown model cost", () => {
  const cost = (extra: Record<string, unknown>) => JSON.stringify({ type: "cost-state", totalCostUSD: 0.5, ...extra });
  for (const extra of [{ modelUsage: {} }, {}, { modelUsage: { m: { costUSD: 1 } }, hasUnknownModelCost: false }]) {
    assert.deepEqual(parseTranscriptChunk(lines(cost(extra)), {}).costState, { totalUsd: 0.5, hasUnknownModelCost: false });
  }
  assert.equal(parseTranscriptChunk(lines(cost({ modelUsage: {}, hasUnknownModelCost: true })), {}).costState?.hasUnknownModelCost, true);
});

test("readTranscriptHead reads the version and entry point from the first complete lines only", () => {
  const dir = tmp();
  try {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, lines(JSON.stringify({ type: "user", version: "2.5.0", entrypoint: "sdk-cli" }), assistant("m1", usage(1, 1, 1, 1))));
    assert.deepEqual(readTranscriptHead(file), { version: "2.5.0", entrypoint: "sdk-cli" });

    // A first line that is still being written carries nothing yet.
    writeFileSync(file, JSON.stringify({ type: "user", version: "2.5.0", entrypoint: "cli" }));
    assert.deepEqual(readTranscriptHead(file), {});
    assert.deepEqual(readTranscriptHead(join(dir, "missing.jsonl")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
