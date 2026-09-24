import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  writeState,
  updateState,
  mergeCost,
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

test("mergeCost touches only the cost field and preserves the rest of the state", () => {
  const { dir, file } = tmpFile();
  try {
    writeState(file, { ...baseState(), promptOpen: { id: "p1", startedAt: 1000, costAtStart: 0.05 } });
    mergeCost(file, { totalUsd: 1.23, updatedAt: 2000, model: "claude-x" });
    const state = readState(file);
    assert.deepEqual(state?.cost, { totalUsd: 1.23, updatedAt: 2000, model: "claude-x" });
    assert.deepEqual(state?.promptOpen, { id: "p1", startedAt: 1000, costAtStart: 0.05 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeCost never lowers updatedAt (a stale write loses the race)", () => {
  const { dir, file } = tmpFile();
  try {
    writeState(file, baseState());
    mergeCost(file, { totalUsd: 2, updatedAt: 5000 });
    mergeCost(file, { totalUsd: 1, updatedAt: 3000 }); // stale, must be ignored
    const state = readState(file);
    assert.equal(state?.cost?.totalUsd, 2);
    assert.equal(state?.cost?.updatedAt, 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeCost creates a minimal state file when none exists yet", () => {
  const { dir, file } = tmpFile();
  try {
    mergeCost(file, { totalUsd: 0.5, updatedAt: 1000 });
    const state = readState(file);
    assert.ok(state);
    assert.equal(state.cost?.totalUsd, 0.5);
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
    cost: null,
    permissionOpen: null,
  };
}
