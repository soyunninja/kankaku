import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClaudePid, isAlive, type PsInfo } from "../src/claude-pid.ts";

function fakeChain(chain: Record<number, PsInfo>): (pid: number) => PsInfo | undefined {
  return (pid) => chain[pid];
}

test("resolveClaudePid returns startPid immediately when its own comm is not a shell or node", () => {
  const runPs = fakeChain({ 100: { ppid: 50, comm: "claude" } });
  assert.equal(resolveClaudePid({ startPid: 100, runPs }), 100);
});

test("resolveClaudePid walks past shell and node ancestors up to 6 hops", () => {
  const runPs = fakeChain({
    100: { ppid: 90, comm: "node" },
    90: { ppid: 80, comm: "bash" },
    80: { ppid: 70, comm: "claude" },
  });
  assert.equal(resolveClaudePid({ startPid: 100, runPs }), 80);
});

test("resolveClaudePid matches comm by basename (a full path)", () => {
  const runPs = fakeChain({ 100: { ppid: 90, comm: "/usr/local/bin/claude" } });
  assert.equal(resolveClaudePid({ startPid: 100, runPs }), 100);
});

test("resolveClaudePid falls back to startPid when ps fails", () => {
  const runPs = (_pid: number) => undefined;
  assert.equal(resolveClaudePid({ startPid: 100, runPs }), 100);
});

test("resolveClaudePid falls back to startPid when nothing qualifies within 6 hops", () => {
  const chain: Record<number, PsInfo> = {};
  let pid = 100;
  for (let i = 0; i < 8; i++) {
    chain[pid] = { ppid: pid - 1, comm: "bash" };
    pid -= 1;
  }
  const runPs = fakeChain(chain);
  assert.equal(resolveClaudePid({ startPid: 100, runPs }), 100);
});

test("isAlive returns true for the current process", () => {
  assert.equal(isAlive(process.pid), true);
});

test("isAlive returns false for a pid that does not exist", () => {
  // A pid unlikely to exist; if this ever flakes on a system with that pid
  // alive, isAlive(process.pid) above still proves the true branch.
  assert.equal(isAlive(999_999), false);
});

test("isAlive returns false for pid 0 without calling process.kill (T7: process.kill(0, 0) signals the process group, not a single process)", () => {
  const original = process.kill;
  let called = false;
  process.kill = ((...args: Parameters<typeof process.kill>) => {
    called = true;
    return original(...args);
  }) as typeof process.kill;
  try {
    assert.equal(isAlive(0), false);
    assert.equal(called, false);
  } finally {
    process.kill = original;
  }
});

test("isAlive returns false for a negative pid without calling process.kill", () => {
  const original = process.kill;
  let called = false;
  process.kill = ((...args: Parameters<typeof process.kill>) => {
    called = true;
    return original(...args);
  }) as typeof process.kill;
  try {
    assert.equal(isAlive(-1), false);
    assert.equal(called, false);
  } finally {
    process.kill = original;
  }
});

test("isAlive returns false for a non-integer pid without calling process.kill", () => {
  const original = process.kill;
  let called = false;
  process.kill = ((...args: Parameters<typeof process.kill>) => {
    called = true;
    return original(...args);
  }) as typeof process.kill;
  try {
    assert.equal(isAlive(1.5), false);
    assert.equal(called, false);
  } finally {
    process.kill = original;
  }
});
