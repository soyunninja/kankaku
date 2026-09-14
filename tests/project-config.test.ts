import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readProjectClient } from "../src/adapters/project-config.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-project-config-"));
}

test("readProjectClient reads client from config.json", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ client: "acme" }));
    assert.equal(readProjectClient(dir), "acme");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectClient returns undefined when config.json is missing", () => {
  const dir = makeTempDir();
  try {
    assert.equal(readProjectClient(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectClient returns undefined when config.json is malformed JSON", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "config.json"), "{not json");
    assert.equal(readProjectClient(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectClient returns undefined when client is missing or not a string", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({}));
    assert.equal(readProjectClient(dir), undefined);

    writeFileSync(join(dir, "config.json"), JSON.stringify({ client: 42 }));
    assert.equal(readProjectClient(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectClient returns undefined when config.json is not a JSON object", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify(["not", "an", "object"]));
    assert.equal(readProjectClient(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LazyProjectClientSource resolves a relative dir against the fallback cwd on read", async () => {
  const { LazyProjectClientSource } = await import("../src/adapters/project-config.ts");
  const cwd = makeTempDir();
  try {
    writeFileSync(join(cwd, "config.json"), JSON.stringify({ client: "acme" }));
    const source = new LazyProjectClientSource(".", () => cwd);
    assert.equal(source.read(), "acme");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
