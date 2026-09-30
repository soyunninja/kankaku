import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionTarget, writeSessionTarget, type SessionTargetLink } from "../src/session-target-store.ts";
import { resolveTargetFile } from "../src/paths.ts";

function tmp(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-target-store-"));
  return { dir, file: join(dir, "sub", "s1.target.json") };
}

const LINK: SessionTargetLink = { hubTaskId: "t1", hubTaskTitle: "Fix login", projectId: "p1", pickedAt: 5, lastList: { kind: "tasks", ids: ["t1", "t2"] } };

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
    writeSessionTarget(t.file, { lastList: { kind: "clients", ids: ["a"] } });
    assert.deepEqual(readSessionTarget(t.file), { lastList: { kind: "clients", ids: ["a"] } });
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
    assert.deepEqual(readSessionTarget(t.file)?.lastList, { kind: "tasks", ids: ["a", "b"] });
    writeFileSync(t.file, JSON.stringify({ hubTaskId: "t1" }));
    assert.equal(readSessionTarget(t.file)?.hubTaskId, "t1");
    assert.deepEqual(readSessionTarget(t.file)?.lastList, { kind: "tasks", ids: [] });
    assert.equal(readFileSync(t.file, "utf8").includes("t1"), true);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("the target fields round-trip: clientId, projectId and pickedTargetAt, with a typed list", () => {
  const t = tmp();
  mkdirSync(join(t.dir, "sub"), { recursive: true });
  try {
    const target: SessionTargetLink = { clientId: "c1", projectId: "p1", pickedTargetAt: 9, lastList: { kind: "projects", ids: ["p1", "p2"] } };
    writeSessionTarget(t.file, target);
    assert.deepEqual(readSessionTarget(t.file), target);
    // a client-only target carries no project
    writeSessionTarget(t.file, { clientId: "c1", pickedTargetAt: 9, lastList: { kind: "clients", ids: [] } });
    assert.equal(readSessionTarget(t.file)?.projectId, undefined);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("an old file with a plain ids array is migrated to a tasks list", () => {
  const t = tmp();
  mkdirSync(join(t.dir, "sub"), { recursive: true });
  try {
    writeFileSync(t.file, JSON.stringify({ hubTaskId: "t1", hubTaskTitle: "X", projectId: "p", pickedAt: 1, lastList: ["a", "b"] }));
    assert.deepEqual(readSessionTarget(t.file)?.lastList, { kind: "tasks", ids: ["a", "b"] });
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("a typed list with an unknown kind or a non-array ids is treated as absent", () => {
  const t = tmp();
  mkdirSync(join(t.dir, "sub"), { recursive: true });
  try {
    for (const bad of ['{"lastList":{"kind":"nope","ids":[]}}', '{"lastList":{"kind":"clients","ids":"x"}}', '{"lastList":{"kind":"clients"}}', '{"clientId":5}', '{"projectId":5}']) {
      writeFileSync(t.file, bad);
      assert.equal(readSessionTarget(t.file), undefined, bad);
    }
    writeFileSync(t.file, JSON.stringify({ lastList: { kind: "clients", ids: ["a", 1, "b"] } }));
    assert.deepEqual(readSessionTarget(t.file)?.lastList, { kind: "clients", ids: ["a", "b"] });
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("pickedTargetAt and projectId without a client are dropped (no target exists)", () => {
  const t = tmp();
  mkdirSync(join(t.dir, "sub"), { recursive: true });
  try {
    writeFileSync(t.file, JSON.stringify({ projectId: "p", pickedTargetAt: 4, lastList: [] }));
    const read = readSessionTarget(t.file);
    assert.equal(read?.projectId, undefined);
    assert.equal(read?.pickedTargetAt, undefined);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});
