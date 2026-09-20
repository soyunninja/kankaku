import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEtimeSeconds, parseProcStat, parseProcStatus, parseProcUptimeSeconds, parsePsEtimes, parsePsOutput, snapshotAncestry, walkAncestry } from "../src/adapters/ancestry.ts";

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

test("parseProcStat reads ppid and starttime ticks from a /proc/<pid>/stat line, tolerating a comm field with spaces/parens", () => {
  // Remainder fields after the comm's closing paren, starting at field 3 (state):
  // idx0 state, idx1 ppid(=4242), idx2 pgrp, idx3 session, idx4 tty_nr, idx5 tpgid,
  // idx6 flags, idx7 minflt, idx8 cminflt, idx9 majflt, idx10 cmajflt, idx11 utime,
  // idx12 stime, idx13 cutime, idx14 cstime, idx15 priority, idx16 nice,
  // idx17 num_threads, idx18 itrealvalue, idx19 starttime(=123456).
  const fields = ["S", "4242", "1", "1", "0", "-1", "4", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", "123456"];
  const stat = `9999 (some (weird) comm) ${fields.join(" ")}`;
  assert.deepEqual(parseProcStat(stat), { ppid: 4242, starttimeTicks: 123456 });
});

test("parseProcStat returns undefined when the line has no closing paren or too few fields", () => {
  assert.equal(parseProcStat("garbage no paren"), undefined);
  assert.equal(parseProcStat("1 (comm) S 2"), undefined);
});

test("parseProcUptimeSeconds reads the first number in /proc/uptime", () => {
  assert.equal(parseProcUptimeSeconds("12345.67 6789.01\n"), 12345.67);
});

test("parseProcUptimeSeconds returns undefined for malformed content", () => {
  assert.equal(parseProcUptimeSeconds("not a number\n"), undefined);
});

test("parseEtimeSeconds parses mm:ss, hh:mm:ss and dd-hh:mm:ss forms (BSD/macOS ps has no etimes keyword)", () => {
  assert.equal(parseEtimeSeconds("00:05"), 5);
  assert.equal(parseEtimeSeconds("01:02:03"), 1 * 3600 + 2 * 60 + 3);
  assert.equal(parseEtimeSeconds("04-02:49:56"), 4 * 86400 + 2 * 3600 + 49 * 60 + 56);
});

test("parseEtimeSeconds returns undefined for malformed input", () => {
  assert.equal(parseEtimeSeconds("garbage"), undefined);
  assert.equal(parseEtimeSeconds(""), undefined);
});

test("parsePsEtimes derives an approximate start epoch (now - etime seconds) per pid", () => {
  const output = "  PID  PPID  ELAPSED\n  100    1     00:30\n  200  100  01:30:00\n";
  const map = parsePsEtimes(output, 1_000_000);
  assert.equal(map.get(100), 1_000_000 - 30_000);
  assert.equal(map.get(200), 1_000_000 - (1 * 3600 + 30 * 60) * 1000);
});

test("parsePsEtimes skips a malformed row rather than throwing", () => {
  const map = parsePsEtimes("PID PPID ELAPSED\n100 1 abc\n200 1 00:05\n", 1_000_000);
  assert.equal(map.has(100), false);
  assert.equal(map.get(200), 1_000_000 - 5000);
});

test("snapshotAncestry on win32 returns an empty snapshot without invoking readProc/readPs (SUBAGENT-REQ-012)", () => {
  let called = false;
  const snapshot = snapshotAncestry({
    platform: "win32",
    readProc: () => {
      called = true;
      return { ppidByPid: new Map(), startIdByPid: new Map() };
    },
    readPs: () => {
      called = true;
      return { ppidByPid: new Map(), startIdByPid: new Map() };
    },
  });
  assert.equal(snapshot.ppidByPid.size, 0);
  assert.equal(snapshot.startIdByPid.size, 0);
  assert.equal(called, false);
});

test("snapshotAncestry prefers the injected /proc reader when it succeeds, carrying start ids too", () => {
  const snapshot = snapshotAncestry({
    platform: "linux",
    readProc: () => ({ ppidByPid: new Map([[100, 1]]), startIdByPid: new Map([[100, 555]]) }),
    readPs: () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(snapshot.ppidByPid.get(100), 1);
  assert.equal(snapshot.startIdByPid.get(100), 555);
});

test("snapshotAncestry falls back to the injected ps reader when /proc fails", () => {
  const snapshot = snapshotAncestry({
    platform: "darwin",
    readProc: () => {
      throw new Error("no /proc on macOS");
    },
    readPs: () => ({ ppidByPid: new Map([[200, 2]]), startIdByPid: new Map([[200, 777]]) }),
  });
  assert.equal(snapshot.ppidByPid.get(200), 2);
  assert.equal(snapshot.startIdByPid.get(200), 777);
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
  assert.deepEqual(snapshot.startIdByPid, new Map());
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
