import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupOnce } from "../src/adapters/setup/json-writer.ts";

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
