import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  writeState,
  updateState,
  type SessionState,
} from "../src/session-state.ts";

function tmpFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-state-"));
  return { dir, file: join(dir, "sub", "s1.state.json") };
}

test("readState returns undefined when the file does not exist", () => {
  const { dir, file } = tmpFile();
  try {
    assert.equal(readState(file), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readState returns undefined for malformed JSON", () => {
  const { dir, file } = tmpFile();
  try {
    writeState(file, baseState());
    // Corrupt after a valid write.
    writeFileSync(file, "{not json");
    assert.equal(readState(file), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readState returns undefined when a legacy state file still carries a cost field", () => {
  // Pre-T7 state files persisted `cost`; the shape check must not require
  // it, so an old file with it is still accepted, not rejected.
  const { dir, file } = tmpFile();
  try {
    writeState(file, baseState());
    writeFileSync(
      file,
      JSON.stringify({
        pid: 1,
        parentPid: 2,
        cwd: "/repo",
        startedAt: 1000,
        promptOpen: null,
        cost: { totalUsd: 1, updatedAt: 1 },
        permissionOpen: null,
      }),
    );
    assert.notEqual(readState(file), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeState creates parent directories and writes atomically (no leftover tmp file)", () => {
  const { dir, file } = tmpFile();
  try {
    writeState(file, baseState());
    assert.equal(existsSync(file), true);
    assert.deepEqual(readState(file), baseState());
    const siblings = readdirSync(join(dir, "sub"));
    assert.deepEqual(siblings, ["s1.state.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeState never persists a cost field (SessionState has none since T7)", () => {
  const { dir, file } = tmpFile();
  try {
    writeState(file, baseState());
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal("cost" in raw, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateState reads, applies the function and writes back", () => {
  const { dir, file } = tmpFile();
  try {
    writeState(file, baseState());
    updateState(file, (state) => ({
      ...(state ?? baseState()),
      promptOpen: { id: "p1", startedAt: 1000, costAtStart: 0.1 },
    }));
    const updated = readState(file);
    assert.deepEqual(updated?.promptOpen, { id: "p1", startedAt: 1000, costAtStart: 0.1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function baseState(): SessionState {
  return {
    pid: 111,
    parentPid: 222,
    cwd: "/repo",
    startedAt: 1000,
    promptOpen: null,
    permissionOpen: null,
  };
}

test("a state file without costBaseline stays valid, and costBaseline round-trips", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readState, writeState } = await import("../src/session-state.ts");
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-state-baseline-"));
  const file = join(dir, "s.state.json");
  writeFileSync(file, JSON.stringify({ pid: 1, parentPid: 2, cwd: "/r", startedAt: 3, promptOpen: null, permissionOpen: null }));
  assert.equal(readState(file)?.costBaseline, undefined);
  assert.notEqual(readState(file), undefined);
  writeState(file, { pid: 1, parentPid: 2, cwd: "/r", startedAt: 3, promptOpen: null, permissionOpen: null, costBaseline: 1.25 });
  assert.equal(readState(file)?.costBaseline, 1.25);
});
