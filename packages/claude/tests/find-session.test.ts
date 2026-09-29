import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSession } from "../src/find-session.ts";
import { writeState } from "../src/session-state.ts";
import { appendEvent } from "../src/event-log.ts";
import type { PsInfo } from "../src/claude-pid.ts";

const state = (pid: number) => ({ pid, parentPid: 1, cwd: "/x", startedAt: 1, promptOpen: null, permissionOpen: null });
const chain = (map: Record<number, PsInfo>) => (pid: number) => map[pid];
const RUNPS = chain({ 500: { ppid: 400, comm: "node" }, 400: { ppid: 300, comm: "zsh" }, 300: { ppid: 1, comm: "claude" } });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-find-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const touch = (file: string, sec: number) => utimesSync(file, sec, sec);

test("finds the session whose state pid is the Claude process reached from the CLI's own pid", () => {
  const s = setup();
  try {
    writeState(join(s.dir, "a.state.json"), state(300));
    writeState(join(s.dir, "b.state.json"), state(999));
    assert.equal(findSession({ claudeDir: s.dir, env: {}, pid: 500, runPs: RUNPS }), "a");
  } finally { s.done(); }
});

test("among several states with that pid, the most recent state mtime wins", () => {
  const s = setup();
  try {
    writeState(join(s.dir, "old.state.json"), state(300));
    writeState(join(s.dir, "new.state.json"), state(300));
    touch(join(s.dir, "old.state.json"), 1000);
    touch(join(s.dir, "new.state.json"), 2000);
    assert.equal(findSession({ claudeDir: s.dir, env: {}, pid: 500, runPs: RUNPS }), "new");
  } finally { s.done(); }
});

test("the last event of the log counts as activity when it is newer than the state file", () => {
  const s = setup();
  try {
    writeState(join(s.dir, "a.state.json"), state(300));
    writeState(join(s.dir, "b.state.json"), state(300));
    touch(join(s.dir, "a.state.json"), 1000);
    touch(join(s.dir, "b.state.json"), 2000);
    appendEvent(join(s.dir, "a.events.jsonl"), { ts: 3_000_000, event: "Stop", stopHookActive: false });
    assert.equal(findSession({ claudeDir: s.dir, env: {}, pid: 500, runPs: RUNPS }), "a");
  } finally { s.done(); }
});

test("no matching pid, no pid at all, or no state files: undefined", () => {
  const s = setup();
  try {
    assert.equal(findSession({ claudeDir: s.dir, env: {}, pid: 500, runPs: RUNPS }), undefined);
    writeState(join(s.dir, "b.state.json"), state(999));
    assert.equal(findSession({ claudeDir: s.dir, env: {}, pid: 500, runPs: RUNPS }), undefined);
    assert.equal(findSession({ claudeDir: s.dir, env: {} }), undefined);
    assert.equal(findSession({ claudeDir: join(s.dir, "missing"), env: {}, pid: 500, runPs: RUNPS }), undefined);
  } finally { s.done(); }
});

test("a placeholder state with pid 0 never matches", () => {
  const s = setup();
  try {
    writeState(join(s.dir, "z.state.json"), state(0));
    assert.equal(findSession({ claudeDir: s.dir, env: {}, pid: 0, runPs: () => undefined }), undefined);
  } finally { s.done(); }
});

test("KANKAKU_CLAUDE_SESSION wins over the pid lookup and needs no state file", () => {
  const s = setup();
  try {
    writeState(join(s.dir, "a.state.json"), state(300));
    assert.equal(findSession({ claudeDir: s.dir, env: { KANKAKU_CLAUDE_SESSION: "forced" }, pid: 500, runPs: RUNPS }), "forced");
  } finally { s.done(); }
});

test("an override that is not a plain session id is ignored", () => {
  const s = setup();
  try {
    writeState(join(s.dir, "a.state.json"), state(300));
    for (const bad of ["../evil", "a/b", "", "  "]) {
      assert.equal(findSession({ claudeDir: s.dir, env: { KANKAKU_CLAUDE_SESSION: bad }, pid: 500, runPs: RUNPS }), "a", bad);
    }
  } finally { s.done(); }
});
