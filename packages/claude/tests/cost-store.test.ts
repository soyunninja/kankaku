import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  costDir,
  costFile,
  readCost,
  writeCost,
  deleteCost,
  sweepStaleCostFiles,
} from "../src/cost-store.ts";

function tmpHome(): { dir: string; env: { HOME: string } } {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-cost-home-"));
  return { dir, env: { HOME: dir } };
}

test("costDir resolves under HOME, never under a project path", () => {
  assert.equal(costDir({ HOME: "/home/x" }), join("/home/x", ".kankaku", "claude", "cost"));
});

test("costFile joins costDir with <sessionId>.json", () => {
  assert.equal(costFile({ HOME: "/home/x" }, "s1"), join("/home/x", ".kankaku", "claude", "cost", "s1.json"));
});

test("readCost returns undefined when the file does not exist", () => {
  const { dir, env } = tmpHome();
  try {
    assert.equal(readCost(env, "s1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCost tolerates malformed JSON", () => {
  const { dir, env } = tmpHome();
  try {
    const file = costFile(env, "s1");
    mkdirSync(join(dir, ".kankaku", "claude", "cost"), { recursive: true });
    writeFileSync(file, "{not json");
    assert.equal(readCost(env, "s1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeCost then readCost round-trips, dir is 0700 and file is 0600", () => {
  const { dir, env } = tmpHome();
  try {
    writeCost(env, "s1", { totalUsd: 1.23, updatedAt: 1000, model: "claude-opus-4" });
    const state = readCost(env, "s1");
    assert.deepEqual(state, { totalUsd: 1.23, updatedAt: 1000, model: "claude-opus-4" });

    const dirMode = statSync(costDir(env)).mode & 0o777;
    assert.equal(dirMode, 0o700);
    const fileMode = statSync(costFile(env, "s1")).mode & 0o777;
    assert.equal(fileMode, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeCost never lowers updatedAt (a stale write loses the race)", () => {
  const { dir, env } = tmpHome();
  try {
    writeCost(env, "s1", { totalUsd: 2, updatedAt: 5000 });
    writeCost(env, "s1", { totalUsd: 1, updatedAt: 3000 }); // stale, must be ignored
    const state = readCost(env, "s1");
    assert.equal(state?.totalUsd, 2);
    assert.equal(state?.updatedAt, 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeCost leaves no leftover tmp file", () => {
  const { dir, env } = tmpHome();
  try {
    writeCost(env, "s1", { totalUsd: 1, updatedAt: 1000 });
    const siblings = readdirSync(costDir(env));
    assert.deepEqual(siblings, ["s1.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteCost removes the file and tolerates it already being gone", () => {
  const { dir, env } = tmpHome();
  try {
    writeCost(env, "s1", { totalUsd: 1, updatedAt: 1000 });
    deleteCost(env, "s1");
    assert.equal(existsSync(costFile(env, "s1")), false);
    assert.doesNotThrow(() => deleteCost(env, "s1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStaleCostFiles deletes files older than maxAgeMs by updatedAt, keeps fresher ones", () => {
  const { dir, env } = tmpHome();
  try {
    writeCost(env, "old", { totalUsd: 1, updatedAt: 0 });
    writeCost(env, "fresh", { totalUsd: 1, updatedAt: 6 * 24 * 60 * 60 * 1000 });

    sweepStaleCostFiles(env, { now: 8 * 24 * 60 * 60 * 1000 }); // default 7-day window

    assert.equal(existsSync(costFile(env, "old")), false);
    assert.equal(existsSync(costFile(env, "fresh")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStaleCostFiles honors a custom maxAgeMs", () => {
  const { dir, env } = tmpHome();
  try {
    writeCost(env, "s1", { totalUsd: 1, updatedAt: 0 });
    sweepStaleCostFiles(env, { now: 1000, maxAgeMs: 500 });
    assert.equal(existsSync(costFile(env, "s1")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStaleCostFiles falls back to mtime for an unparsable file and does nothing when the cost dir is absent", () => {
  const { dir, env } = tmpHome();
  try {
    // No cost dir yet: must not throw.
    assert.doesNotThrow(() => sweepStaleCostFiles(env, { now: 1000 }));

    mkdirSync(costDir(env), { recursive: true });
    writeFileSync(costFile(env, "bad"), "{not json");
    sweepStaleCostFiles(env, { now: Date.now() + 8 * 24 * 60 * 60 * 1000 });
    assert.equal(existsSync(costFile(env, "bad")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
