import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionTarget, writeSessionTarget, type SessionTargetLink } from "../src/session-target-store.ts";
import { resolveTargetFile } from "../src/paths.ts";

function tmp(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-target-store-"));
  return { dir, file: join(dir, "sub", "s1.target.json") };
}

const LINK: SessionTargetLink = { hubTaskId: "t1", hubTaskTitle: "Fix login", projectId: "p1", pickedAt: 5, lastList: ["t1", "t2"] };

test("resolveTargetFile is <claudeDir>/<session>.target.json", () => {
  assert.equal(resolveTargetFile("/d/claude", "abc"), join("/d/claude", "abc.target.json"));
});

test("readSessionTarget is undefined for a missing file", () => {
  const t = tmp();
  try { assert.equal(readSessionTarget(t.file), undefined); } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("write then read round-trips, creating parents and leaving no tmp file", () => {
  const t = tmp();
  try {
    writeSessionTarget(t.file, LINK);
    assert.deepEqual(readSessionTarget(t.file), LINK);
    assert.deepEqual(readdirSync(join(t.dir, "sub")), ["s1.target.json"]);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("a file with only a lastList is readable and carries no link", () => {
  const t = tmp();
  try {
    writeSessionTarget(t.file, { lastList: ["a"] });
    assert.deepEqual(readSessionTarget(t.file), { lastList: ["a"] });
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("malformed content is treated as absent", () => {
  const t = tmp();
  try {
    writeSessionTarget(t.file, LINK);
    for (const bad of ["{not json", "[]", "null", '"x"', '{"hubTaskId":5}', '{"lastList":"nope"}']) {
      writeFileSync(t.file, bad);
      assert.equal(readSessionTarget(t.file), undefined, bad);
    }
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("a partly valid file keeps the valid fields and drops non-string list entries", () => {
  const t = tmp();
  try {
    writeSessionTarget(t.file, LINK);
    writeFileSync(t.file, JSON.stringify({ hubTaskId: "t1", hubTaskTitle: "X", projectId: "p", pickedAt: 1, lastList: ["a", 3, "b"] }));
    assert.deepEqual(readSessionTarget(t.file)?.lastList, ["a", "b"]);
    writeFileSync(t.file, JSON.stringify({ hubTaskId: "t1" }));
    assert.equal(readSessionTarget(t.file)?.hubTaskId, "t1");
    assert.deepEqual(readSessionTarget(t.file)?.lastList, []);
    assert.equal(readFileSync(t.file, "utf8").includes("t1"), true);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});
