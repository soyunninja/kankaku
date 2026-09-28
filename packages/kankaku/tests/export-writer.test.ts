import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { writeExport } from "../src/adapters/export-writer.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-export-writer-"));
}

test("writeExport writes the file under <dir>/export/<name> and returns its absolute path", () => {
  const dir = makeTempDir();
  try {
    const path = writeExport(dir, "tasks-2026-09-10.csv", "id,day\np1,2026-09-10");

    assert.ok(isAbsolute(path));
    assert.equal(path, join(dir, "export", "tasks-2026-09-10.csv"));
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path, "utf8"), "id,day\np1,2026-09-10");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeExport creates the export directory when missing", () => {
  const dir = makeTempDir();
  try {
    assert.equal(existsSync(join(dir, "export")), false);
    writeExport(dir, "tasks-all.json", "[]");
    assert.equal(existsSync(join(dir, "export")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeExport overwrites an existing file with the same name", () => {
  const dir = makeTempDir();
  try {
    writeExport(dir, "tasks-all.json", "[1]");
    writeExport(dir, "tasks-all.json", "[2]");
    assert.equal(readFileSync(join(dir, "export", "tasks-all.json"), "utf8"), "[2]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LazyExportWriter resolves a relative dir against the fallback cwd on write", async () => {
  const { LazyExportWriter } = await import("../src/adapters/export-writer.ts");
  const cwd = makeTempDir();
  try {
    const writer = new LazyExportWriter(".", () => cwd);
    const path = writer.write("tasks-all.csv", "id\n");
    assert.equal(path, join(cwd, "export", "tasks-all.csv"));
    assert.equal(readFileSync(path, "utf8"), "id\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
