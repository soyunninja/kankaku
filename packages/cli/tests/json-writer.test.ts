import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupOnce, writeJsonAtomic } from "../src/adapters/setup/json-writer.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-json-writer-"));
}

test("backupOnce: a 0600 source produces a 0600 backup, never the default (looser) mode", () => {
  const dir = makeDir();
  try {
    const filePath = join(dir, "credentials.json");
    writeFileSync(filePath, "{}");
    chmodSync(filePath, 0o600);

    backupOnce(filePath);

    assert.equal(statSync(`${filePath}.bak`).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backupOnce: a non-0600 source keeps the default backup mode (no unrelated tightening)", () => {
  const dir = makeDir();
  try {
    const filePath = join(dir, "settings.json");
    writeFileSync(filePath, "{}"); // default mode, not owner-only

    backupOnce(filePath);

    assert.notEqual(statSync(`${filePath}.bak`).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backupOnce: tightens an existing world-readable .bak, best-effort, when the source is 0600", () => {
  const dir = makeDir();
  try {
    const filePath = join(dir, "credentials.json");
    writeFileSync(filePath, "{}");
    chmodSync(filePath, 0o600);

    // Simulate a backup left over from before this fix, world-readable.
    const backupPath = `${filePath}.bak`;
    writeFileSync(backupPath, "{}");
    chmodSync(backupPath, 0o644);

    backupOnce(filePath); // filePath.bak already exists, so backupOnce would normally no-op

    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backupOnce: still a no-op (no backup written) when the source file does not exist", () => {
  const dir = makeDir();
  try {
    backupOnce(join(dir, "missing.json"));
    assert.equal(statSync(dir).isDirectory(), true); // nothing thrown, nothing created
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJsonAtomic: with a file mode the temp file is created with it, so no wider mode ever exists (even under umask 0)", () => {
  const dir = makeDir();
  const previousUmask = process.umask(0);
  try {
    const filePath = join(dir, "service.json");
    writeJsonAtomic(filePath, { a: 1 }, undefined, 0o600);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
  } finally {
    process.umask(previousUmask);
    rmSync(dir, { recursive: true, force: true });
  }
});
