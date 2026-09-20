import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProcStatus, parsePsOutput, snapshotAncestry, walkAncestry } from "../src/adapters/ancestry.ts";

test("parsePsOutput parses pid/ppid rows, skipping the header and blank lines", () => {
  const output = "  PID  PPID\n  100    1\n  200  100\n\n";
  const map = parsePsOutput(output);
  assert.equal(map.get(100), 1);
  assert.equal(map.get(200), 100);
  assert.equal(map.size, 2);
});

test("parsePsOutput skips a malformed row rather than throwing", () => {
  const map = parsePsOutput("PID PPID\n100 abc\ngarbage\n200 1\n");
  assert.equal(map.get(200), 1);
  assert.equal(map.has(100), false);
});

test("parseProcStatus reads the PPid: line", () => {
  const status = "Name:\tbash\nState:\tS\nPPid:\t4242\nUid:\t0\n";
  assert.equal(parseProcStatus(status), 4242);
});

test("parseProcStatus returns undefined when the PPid line is missing or malformed", () => {
  assert.equal(parseProcStatus("Name:\tbash\n"), undefined);
  assert.equal(parseProcStatus("PPid:\tabc\n"), undefined);
});

test("snapshotAncestry on win32 returns an empty snapshot without invoking readProc/readPs (SUBAGENT-REQ-012)", () => {
  let called = false;
  const snapshot = snapshotAncestry({
    platform: "win32",
    readProc: () => {
      called = true;
      return new Map();
    },
    readPs: () => {
      called = true;
      return new Map();
    },
  });
  assert.equal(snapshot.ppidByPid.size, 0);
  assert.equal(called, false);
});

test("snapshotAncestry prefers the injected /proc reader when it succeeds", () => {
  const snapshot = snapshotAncestry({
    platform: "linux",
    readProc: () => new Map([[100, 1]]),
    readPs: () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(snapshot.ppidByPid.get(100), 1);
});

test("snapshotAncestry falls back to the injected ps reader when /proc fails", () => {
  const snapshot = snapshotAncestry({
    platform: "darwin",
    readProc: () => {
      throw new Error("no /proc on macOS");
    },
    readPs: () => new Map([[200, 2]]),
  });
  assert.equal(snapshot.ppidByPid.get(200), 2);
});

test("snapshotAncestry degrades to an empty snapshot when both mechanisms fail, never throwing", () => {
  const snapshot = snapshotAncestry({
    readProc: () => {
      throw new Error("fail");
    },
    readPs: () => {
      throw new Error("fail");
    },
  });
  assert.deepEqual(snapshot.ppidByPid, new Map());
});

test("walkAncestry collects ancestor pids nearest-first, walking past a non-tracked hop", () => {
  const ppidByPid = new Map([
    [50, 40],
    [40, 30],
    [30, 1],
  ]);
  assert.deepEqual(walkAncestry(50, ppidByPid), [50, 40, 30]);
});

test("walkAncestry stops at the OS/init root (pid <= 1)", () => {
  const ppidByPid = new Map([[2, 1]]);
  assert.deepEqual(walkAncestry(2, ppidByPid), [2]);
  assert.deepEqual(walkAncestry(1, ppidByPid), []);
});

test("walkAncestry stops when a pid is missing from the snapshot", () => {
  const ppidByPid = new Map([[50, 40]]);
  assert.deepEqual(walkAncestry(50, ppidByPid), [50, 40]);
});

test("walkAncestry never loops forever on a cyclic map, and respects maxHops", () => {
  const ppidByPid = new Map([
    [10, 20],
    [20, 10],
  ]);
  assert.deepEqual(walkAncestry(10, ppidByPid), [10, 20]);
  assert.equal(walkAncestry(10, ppidByPid, 1).length, 1);
});
