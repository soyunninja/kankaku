import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTuiConfig } from "../src/adapters/tui-config.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-home-"));
}

test("readTuiConfig reads roots from ~/.kankaku/tui.json", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".kankaku"), { recursive: true });
    writeFileSync(join(home, ".kankaku", "tui.json"), JSON.stringify({ roots: ["/abs/path", "~/relative-to-home"] }));
    const config = readTuiConfig(home, "/somewhere/else");
    assert.deepEqual(config.roots, ["/abs/path", join(home, "relative-to-home")]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readTuiConfig falls back to cwd when the file is missing", () => {
  const home = makeHome();
  try {
    const config = readTuiConfig(home, "/somewhere/else");
    assert.deepEqual(config.roots, ["/somewhere/else"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readTuiConfig falls back to cwd when the file is malformed", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".kankaku"), { recursive: true });
    writeFileSync(join(home, ".kankaku", "tui.json"), "not json");
    const config = readTuiConfig(home, "/somewhere/else");
    assert.deepEqual(config.roots, ["/somewhere/else"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readTuiConfig falls back to cwd when roots is not an array of strings", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".kankaku"), { recursive: true });
    writeFileSync(join(home, ".kankaku", "tui.json"), JSON.stringify({ roots: "nope" }));
    const config = readTuiConfig(home, "/somewhere/else");
    assert.deepEqual(config.roots, ["/somewhere/else"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
