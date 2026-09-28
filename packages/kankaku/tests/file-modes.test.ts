import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { ensureDirMode, OWNER_DIR_MODE, OWNER_FILE_MODE, tightenMode } from "../src/adapters/file-modes.ts";

const posix = platform() !== "win32";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "kankaku-file-modes-"));
});

after(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

test("ensureDirMode creates a fresh directory with the given mode", { skip: !posix }, () => {
  const dir = join(base, "fresh");
  ensureDirMode(dir, 0o700);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("ensureDirMode tightens an existing looser directory", { skip: !posix }, () => {
  const dir = join(base, "existing");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  assert.equal(statSync(dir).mode & 0o777, 0o755);

  ensureDirMode(dir, 0o700);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("ensureDirMode never throws when the path is not writable", () => {
  assert.doesNotThrow(() => ensureDirMode(join(base, "does", "not", "exist", "either", "way")));
});

test("tightenMode chmods a file down to the given mode when it is currently looser", { skip: !posix }, () => {
  const file = join(base, "f.json");
  writeFileSync(file, "{}", { mode: 0o644 });
  assert.equal(statSync(file).mode & 0o777, 0o644);

  tightenMode(file, 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("tightenMode leaves an already-tight file alone", { skip: !posix }, () => {
  const file = join(base, "f2.json");
  writeFileSync(file, "{}", { mode: 0o600 });

  tightenMode(file, 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("tightenMode never widens a mode that is already tighter than requested", { skip: !posix }, () => {
  const file = join(base, "f3.json");
  writeFileSync(file, "{}", { mode: 0o400 });

  tightenMode(file, 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o400);
});

test("tightenMode never throws when the path does not exist", () => {
  assert.doesNotThrow(() => tightenMode(join(base, "missing.json")));
});

test("exports the documented default owner-only modes", () => {
  assert.equal(OWNER_DIR_MODE, 0o700);
  assert.equal(OWNER_FILE_MODE, 0o600);
});
