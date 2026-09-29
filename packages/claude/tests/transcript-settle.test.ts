import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackTranscriptAtSubmit, settleTranscripts } from "../src/transcript-settle.ts";

function assistant(id: string, input: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: "assistant", ...extra, message: { id, usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`;
}

function setup(): { dir: string; main: string; sub: string } {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-settle-"));
  const main = join(dir, "sess.jsonl");
  const sub = join(dir, "sess", "subagents");
  mkdirSync(sub, { recursive: true });
  return { dir, main, sub };
}

test("trackTranscriptAtSubmit without a path leaves the transcript state as it was", () => {
  assert.equal(trackTranscriptAtSubmit(undefined, undefined), undefined);
  const existing = { path: "/x/a.jsonl", offsets: { "/x/a.jsonl": { bytes: 3 } } };
  assert.equal(trackTranscriptAtSubmit(existing, undefined), existing);
});

test("trackTranscriptAtSubmit records the current sizes of the main and subagent files without reading them", () => {
  const { dir, main, sub } = setup();
  try {
    writeFileSync(main, assistant("m1", 1));
    writeFileSync(join(sub, "a.jsonl"), assistant("s1", 2));
    writeFileSync(join(sub, "a.json"), "{}");
    const result = trackTranscriptAtSubmit(undefined, main);
    assert.deepEqual(result, {
      path: main,
      offsets: {
        [main]: { bytes: statSync(main).size },
        [join(sub, "a.jsonl")]: { bytes: statSync(join(sub, "a.jsonl")).size },
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trackTranscriptAtSubmit keeps existing offsets for the same path and resets them for a new path", () => {
  const { dir, main } = setup();
  try {
    writeFileSync(main, assistant("m1", 1));
    const existing = { path: main, offsets: { [main]: { bytes: 5, lastMessageId: "m0" } }, agentVersion: "1.0.0", entrypoint: "cli" };
    assert.equal(trackTranscriptAtSubmit(existing, main), existing);

    const other = join(dir, "other.jsonl");
    writeFileSync(other, "abcd\n");
    assert.deepEqual(trackTranscriptAtSubmit(existing, other), {
      path: other,
      offsets: { [other]: { bytes: 5 } },
      agentVersion: "1.0.0",
      entrypoint: "cli",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trackTranscriptAtSubmit with a missing file stores the path and no offsets", () => {
  const { dir, main } = setup();
  try {
    assert.deepEqual(trackTranscriptAtSubmit(undefined, main), { path: main, offsets: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settleTranscripts sums new bytes of the main and every subagent file and advances the offsets", () => {
  const { dir, main, sub } = setup();
  try {
    writeFileSync(main, assistant("m0", 100));
    const tracked = trackTranscriptAtSubmit(undefined, main)!;
    appendFileSync(main, assistant("m1", 1, { version: "3.4.5", entrypoint: "cli" }));
    writeFileSync(join(sub, "a.jsonl"), assistant("s1", 10));
    writeFileSync(join(sub, "b.jsonl"), assistant("s2", 100));

    const result = settleTranscripts(tracked)!;
    assert.deepEqual(result.tokens, { input: 111, output: 3, cacheRead: 0, cacheWrite: 0 });
    assert.equal(result.truncated, false);
    assert.equal(result.transcript.entrypoint, "cli");
    assert.equal(result.transcript.offsets[main]?.bytes, statSync(main).size);
    assert.equal(result.transcript.offsets[join(sub, "a.jsonl")]?.bytes, statSync(join(sub, "a.jsonl")).size);

    // A second settle with nothing new counts nothing.
    const again = settleTranscripts(result.transcript)!;
    assert.deepEqual(again.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(again.transcript.agentVersion, "3.4.5", "a version once seen is kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settleTranscripts prefers the main transcript's version and keeps tokens read between prompts for the next settle", () => {
  const { dir, main, sub } = setup();
  try {
    writeFileSync(main, "");
    const tracked = trackTranscriptAtSubmit(undefined, main)!;
    writeFileSync(join(sub, "a.jsonl"), assistant("s1", 5, { version: "sub-version" }));
    appendFileSync(main, assistant("m1", 7, { version: "main-version" }));

    const first = settleTranscripts(tracked)!;
    assert.equal(first.transcript.agentVersion, "main-version");
    // Nothing settles between prompts, so a later settle sees the growth since the last stored offsets.
    appendFileSync(main, assistant("m2", 20));
    const second = settleTranscripts(first.transcript)!;
    assert.equal(second.tokens?.input, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settleTranscripts reads a main transcript without a stored offset from 0", () => {
  const { dir, main } = setup();
  try {
    writeFileSync(main, assistant("m1", 4));
    const result = settleTranscripts({ path: main, offsets: {} })!;
    assert.equal(result.tokens?.input, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settleTranscripts over the byte bound drops the tokens, advances the offsets and flags truncated", () => {
  const { dir, main, sub } = setup();
  try {
    writeFileSync(main, assistant("m1", 4));
    writeFileSync(join(sub, "a.jsonl"), assistant("s1", 6));
    const result = settleTranscripts({ path: main, offsets: {} }, { maxBytes: 150 })!;
    assert.equal(result.truncated, true);
    assert.equal(result.tokens, undefined);
    assert.equal(result.transcript.offsets[main]?.bytes, statSync(main).size);
    assert.equal(result.transcript.offsets[join(sub, "a.jsonl")]?.bytes, statSync(join(sub, "a.jsonl")).size);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settleTranscripts on a missing transcript counts nothing and keeps the offsets", () => {
  const { dir, main } = setup();
  try {
    const transcript = { path: main, offsets: { [main]: { bytes: 9 } } };
    const result = settleTranscripts(transcript)!;
    assert.deepEqual(result.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(result.transcript.offsets, transcript.offsets);
    assert.equal(settleTranscripts(undefined), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settleTranscripts returns the main transcript's last cost-state", () => {
  const { dir, main } = setup();
  try {
    writeFileSync(main, `${JSON.stringify({ type: "cost-state", totalCostUSD: 0.25, hasUnknownModelCost: false })}\n`);
    const result = settleTranscripts({ path: main, offsets: {} })!;
    assert.deepEqual(result.costState, { totalUsd: 0.25, hasUnknownModelCost: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- waitForTranscript ----

import { waitForTranscript } from "../src/transcript-settle.ts";

function clockFor(onSleep?: (now: number) => void) {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
      onSleep?.(now);
    },
    sleeps,
    total: () => sleeps.reduce((a, b) => a + b, 0),
  };
}

test("waitForTranscript never returns before 100 ms after the start, even when a line is already there and stable", async () => {
  const { dir, main } = setup();
  try {
    writeFileSync(main, "");
    const tracked = trackTranscriptAtSubmit(undefined, main)!;
    appendFileSync(main, assistant("m1", 1));
    const clock = clockFor();
    await waitForTranscript(tracked, clock);
    assert.deepEqual(clock.sleeps, [25, 25, 25, 25]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForTranscript waits for a line that arrives late and then for the size to settle", async () => {
  const { dir, main } = setup();
  try {
    writeFileSync(main, "");
    const tracked = trackTranscriptAtSubmit(undefined, main)!;
    let wrote = false;
    const clock = clockFor((now) => {
      if (now >= 50 && !wrote) {
        wrote = true;
        appendFileSync(main, assistant("m1", 1));
      }
    });
    await waitForTranscript(tracked, clock);
    assert.equal(wrote, true);
    assert.ok(clock.total() >= 100 && clock.total() < 300, `waited ${clock.total()} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForTranscript gives up after 300 ms when nothing arrives", async () => {
  const { dir, main } = setup();
  try {
    writeFileSync(main, "");
    const clock = clockFor();
    await waitForTranscript(trackTranscriptAtSubmit(undefined, main)!, clock);
    assert.equal(clock.total(), 300);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForTranscript gives up after 300 ms when the file keeps growing, and without a transcript does nothing", async () => {
  const { dir, main } = setup();
  try {
    writeFileSync(main, "");
    let n = 0;
    const clock = clockFor(() => appendFileSync(main, assistant(`g${n++}`, 1)));
    await waitForTranscript(trackTranscriptAtSubmit(undefined, main)!, clock);
    assert.equal(clock.total(), 300);

    const idle = clockFor();
    await waitForTranscript(undefined, idle);
    assert.deepEqual(idle.sleeps, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settleTranscripts reports the model of the last assistant line, main first, and keeps the stored one", () => {
  const { dir, main, sub } = setup();
  try {
    const line = (id: string, model: string) => `${JSON.stringify({ type: "assistant", message: { id, model, usage: { input_tokens: 1 } } })}\n`;
    writeFileSync(main, line("m1", "main-model"));
    writeFileSync(join(sub, "a.jsonl"), line("s1", "sub-model"));
    const first = settleTranscripts({ path: main, offsets: {} })!;
    assert.equal(first.transcript.model, "main-model");
    const second = settleTranscripts(first.transcript)!;
    assert.equal(second.transcript.model, "main-model");
    writeFileSync(main, "");
    rmSync(main);
    const onlySub = settleTranscripts({ path: main, offsets: {} })!;
    assert.equal(onlySub.transcript.model, "sub-model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settleTranscripts learns the entry point and version from the head of the file when the new bytes carry none", () => {
  const { dir, main } = setup();
  try {
    writeFileSync(main, `${JSON.stringify({ type: "user", version: "2.5.0", entrypoint: "sdk-cli" })}\n`);
    const tracked = trackTranscriptAtSubmit(undefined, main)!; // positioned after that line
    const result = settleTranscripts(tracked)!;
    assert.equal(result.transcript.entrypoint, "sdk-cli");
    assert.equal(result.transcript.agentVersion, "2.5.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


function lateLine(main: string, at: number, id: string) {
  let wrote = false;
  return (now: number) => {
    if (now >= at && !wrote) {
      wrote = true;
      appendFileSync(main, assistant(id, 1));
    }
  };
}

function readAfter(main: string, tracked: NonNullable<ReturnType<typeof trackTranscriptAtSubmit>>): number {
  return settleTranscripts(tracked)!.tokens!.input;
}

test("waitForTranscript: an earlier assistant line on disk does not end the wait before the last one lands at 60 ms", async () => {
  const { dir, main } = setup();
  try {
    writeFileSync(main, "");
    const tracked = trackTranscriptAtSubmit(undefined, main)!;
    appendFileSync(main, assistant("m1", 1));
    const clock = clockFor(lateLine(main, 60, "m2"));
    await waitForTranscript(tracked, clock);
    assert.equal(readAfter(main, tracked), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForTranscript: a line arriving at 250 ms is counted (stability is re-established before 300 ms), one at 320 ms is left for the next settle", async () => {
  const a = setup();
  const b = setup();
  try {
    writeFileSync(a.main, "");
    const trackedA = trackTranscriptAtSubmit(undefined, a.main)!;
    const at250 = clockFor(lateLine(a.main, 250, "m1"));
    await waitForTranscript(trackedA, at250);
    assert.equal(readAfter(a.main, trackedA), 1);
    assert.ok(at250.total() > 250 && at250.total() < 300, `waited ${at250.total()} ms`);

    writeFileSync(b.main, "");
    const trackedB = trackTranscriptAtSubmit(undefined, b.main)!;
    const at320 = clockFor(lateLine(b.main, 320, "m1"));
    await waitForTranscript(trackedB, at320);
    assert.equal(at320.total(), 300);
    assert.equal(readAfter(b.main, trackedB), 0);
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("waitForTranscript: once 100 ms have passed with a stable line on disk it stops, leaving a later line to the next settle", async () => {
  const { dir, main } = setup();
  try {
    writeFileSync(main, "");
    const tracked = trackTranscriptAtSubmit(undefined, main)!;
    appendFileSync(main, assistant("m1", 1));
    const clock = clockFor(lateLine(main, 320, "m2"));
    await waitForTranscript(tracked, clock);
    assert.equal(clock.total(), 100);
    assert.equal(readAfter(main, tracked), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForTranscript counts time already spent since the hook started: 400 ms in, it does not sleep at all", async () => {
  const { dir, main } = setup();
  try {
    writeFileSync(main, "");
    const tracked = trackTranscriptAtSubmit(undefined, main)!;
    const clock = clockFor();
    await waitForTranscript(tracked, { now: () => clock.now() + 400, sleep: clock.sleep }, 0);
    assert.deepEqual(clock.sleeps, []);

    // 150 ms in with a stable line on disk: only the one stability poll interval runs.
    appendFileSync(main, assistant("m1", 1));
    const partly = clockFor();
    await waitForTranscript(tracked, { now: () => partly.now() + 150, sleep: partly.sleep }, 0);
    assert.deepEqual(partly.sleeps, [25]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
