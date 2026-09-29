import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readProjectClient, readProjectTargetIds, writeProjectTargetIds } from "../src/adapters/project-config.ts";

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

test("readProjectTargetIds reads clientId and projectId from config.json", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ clientId: "c1", projectId: "p1" }));
    assert.deepEqual(readProjectTargetIds(dir), { clientId: "c1", projectId: "p1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectTargetIds reads clientId without a projectId", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ clientId: "c1" }));
    assert.deepEqual(readProjectTargetIds(dir), { clientId: "c1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectTargetIds returns undefined when clientId is absent, non-string, missing file, or malformed JSON", () => {
  const dir = makeTempDir();
  try {
    assert.equal(readProjectTargetIds(dir), undefined);

    writeFileSync(join(dir, "config.json"), JSON.stringify({ projectId: "p1" }));
    assert.equal(readProjectTargetIds(dir), undefined);

    writeFileSync(join(dir, "config.json"), JSON.stringify({ clientId: 42 }));
    assert.equal(readProjectTargetIds(dir), undefined);

    writeFileSync(join(dir, "config.json"), "{not json");
    assert.equal(readProjectTargetIds(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectTargetIds drops a non-string projectId but keeps clientId", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ clientId: "c1", projectId: 42 }));
    assert.deepEqual(readProjectTargetIds(dir), { clientId: "c1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeProjectTargetIds creates config.json with clientId/projectId when none existed", () => {
  const dir = makeTempDir();
  try {
    writeProjectTargetIds(dir, { clientId: "c1", projectId: "p1" });
    const written = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.deepEqual(written, { clientId: "c1", projectId: "p1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeProjectTargetIds merges into an existing config.json, preserving other keys like the legacy client label", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ client: "legacy-acme", other: true }));
    writeProjectTargetIds(dir, { clientId: "c1", projectId: "p1" });
    const written = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.deepEqual(written, { client: "legacy-acme", other: true, clientId: "c1", projectId: "p1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeProjectTargetIds tolerates malformed existing JSON by overwriting it", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "config.json"), "{not json");
    writeProjectTargetIds(dir, { clientId: "c1" });
    const written = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.deepEqual(written, { clientId: "c1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeProjectTargetIds omits projectId when not given", () => {
  const dir = makeTempDir();
  try {
    writeProjectTargetIds(dir, { clientId: "c1" });
    const written = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.deepEqual(written, { clientId: "c1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LazyProjectTargetSource reads and writes against a relative dir resolved from the fallback cwd", async () => {
  const { LazyProjectTargetSource } = await import("../src/adapters/project-config.ts");
  const cwd = makeTempDir();
  try {
    const source = new LazyProjectTargetSource(".", () => cwd);
    assert.equal(source.read(), undefined);

    source.write({ clientId: "c1", projectId: "p1" });
    assert.deepEqual(source.read(), { clientId: "c1", projectId: "p1" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
