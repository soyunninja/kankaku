import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, listStateFiles } from "../src/paths.ts";

test("resolvePaths joins KANKAKU_DIR (or the .kankaku default) with a claude/ subdir and per-session file names", () => {
  const cwd = "/repo";
  const withEnv = resolvePaths({ env: { KANKAKU_DIR: "/data/kankaku" }, cwd, sessionId: "abc" });
  assert.equal(withEnv.kankakuDir, "/data/kankaku");
  assert.equal(withEnv.claudeDir, join("/data/kankaku", "claude"));
  assert.equal(withEnv.eventsFile, join("/data/kankaku", "claude", "abc.events.jsonl"));
  assert.equal(withEnv.stateFile, join("/data/kankaku", "claude", "abc.state.json"));

  const withDefault = resolvePaths({ env: {}, cwd, sessionId: "abc" });
  assert.equal(withDefault.kankakuDir, join("/repo", ".kankaku"));
});

test("resolvePaths resolves a relative KANKAKU_DIR against cwd", () => {
  const paths = resolvePaths({ env: { KANKAKU_DIR: "data" }, cwd: "/repo", sessionId: "s1" });
  assert.equal(paths.kankakuDir, join("/repo", "data"));
});

test("listStateFiles returns every *.state.json path in claudeDir, absolute", () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-paths-"));
  try {
    writeFileSync(join(dir, "a.state.json"), "{}");
    writeFileSync(join(dir, "b.state.json"), "{}");
    writeFileSync(join(dir, "a.events.jsonl"), "");
    const files = listStateFiles(dir).sort();
    assert.deepEqual(
      files,
      [join(dir, "a.state.json"), join(dir, "b.state.json")].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listStateFiles returns an empty array when the directory does not exist", () => {
  assert.deepEqual(listStateFiles(join(tmpdir(), "kankaku-claude-paths-missing")), []);
});
