import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tuiConfigPath, writeTuiConfig } from "../src/adapters/setup/tui-config.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-setup-tuicfg-"));
}

test("writeTuiConfig: writes { roots } to ~/.kankaku/tui.json, creating ~/.kankaku (0700) when missing", () => {
  const home = makeHome();
  try {
    const result = writeTuiConfig(home, ["/workspace/a", "/workspace/b"]);
    assert.equal(result.changed, true);

    const filePath = tuiConfigPath(home);
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), { roots: ["/workspace/a", "/workspace/b"] });
    assert.equal(statSync(join(home, ".kankaku")).mode & 0o777, 0o700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeTuiConfig: never chmods an already-existing ~/.kankaku directory", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".kankaku"), { recursive: true, mode: 0o755 });
    writeTuiConfig(home, ["/workspace"]);
    assert.equal(statSync(join(home, ".kankaku")).mode & 0o777, 0o755);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeTuiConfig: is a no-op when roots already match exactly", () => {
  const home = makeHome();
  try {
    writeTuiConfig(home, ["/workspace"]);
    const before = readFileSync(tuiConfigPath(home), "utf8");

    const result = writeTuiConfig(home, ["/workspace"]);
    assert.equal(result.changed, false);
    assert.equal(readFileSync(tuiConfigPath(home), "utf8"), before);
    assert.equal(existsSync(`${tuiConfigPath(home)}.bak`), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeTuiConfig: backs up the previous tui.json before overwriting with different roots", () => {
  const home = makeHome();
  try {
    writeTuiConfig(home, ["/workspace/old"]);
    const originalText = readFileSync(tuiConfigPath(home), "utf8");

    writeTuiConfig(home, ["/workspace/new"]);

    assert.equal(readFileSync(`${tuiConfigPath(home)}.bak`, "utf8"), originalText);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeTuiConfig: preserves any other existing key in tui.json", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".kankaku"), { recursive: true });
    writeFileSync(tuiConfigPath(home), JSON.stringify({ roots: ["/old"], extra: "kept" }, null, 2));

    writeTuiConfig(home, ["/new"]);

    const written = JSON.parse(readFileSync(tuiConfigPath(home), "utf8"));
    assert.deepEqual(written, { roots: ["/new"], extra: "kept" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
