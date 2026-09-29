import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addKankakuPackage, removeKankakuPackage } from "../src/adapters/setup/pi.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-setup-pi-"));
}

test("addKankakuPackage: appends 'npm:kankaku-pi' to packages, preserving every other key and its order", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const original = { defaultModel: "gpt-6", packages: ["npm:pi-mcp-adapter", "npm:pi-lens"], theme: "Gentleman-Sexy" };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const result = addKankakuPackage(settingsPath);
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(Object.keys(written), ["defaultModel", "packages", "theme"]);
    assert.deepEqual(written.packages, ["npm:pi-mcp-adapter", "npm:pi-lens", "npm:kankaku-pi"]);
    assert.equal(written.defaultModel, "gpt-6");
    assert.equal(written.theme, "Gentleman-Sexy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addKankakuPackage: is a no-op when kankaku is already present (exact npm spec)", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:kankaku"] }, null, 2));
    const before = readFileSync(settingsPath, "utf8");

    const result = addKankakuPackage(settingsPath);
    assert.equal(result.changed, false);
    assert.equal(readFileSync(settingsPath, "utf8"), before);
    assert.equal(existsSync(`${settingsPath}.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addKankakuPackage: is a no-op when kankaku is already present as a local path", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ packages: ["../../workspace/kankaku"] }, null, 2));
    const result = addKankakuPackage(settingsPath);
    assert.equal(result.changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addKankakuPackage: backs up the original file to <file>.bak before the first modification", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const originalText = JSON.stringify({ packages: [] }, null, 2);
    writeFileSync(settingsPath, originalText);

    addKankakuPackage(settingsPath);

    assert.equal(existsSync(`${settingsPath}.bak`), true);
    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), originalText);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addKankakuPackage: never overwrites an existing .bak", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ packages: [] }, null, 2));
    writeFileSync(`${settingsPath}.bak`, "pre-existing backup, do not touch");

    addKankakuPackage(settingsPath);

    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), "pre-existing backup, do not touch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addKankakuPackage: leaves no leftover tmp files after writing", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ packages: [] }, null, 2));
    addKankakuPackage(settingsPath);
    const entries = readdirSync(dir);
    assert.deepEqual(
      entries.sort(),
      ["settings.json", "settings.json.bak"].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addKankakuPackage: creates the settings file's directory when missing, treating a missing file as an empty packages list", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "nested", "settings.json");
    const result = addKankakuPackage(settingsPath);
    assert.equal(result.changed, true);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.packages, ["npm:kankaku-pi"]);
    assert.equal(existsSync(`${settingsPath}.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeKankakuPackage: removes every kankaku entry from packages, preserving other keys and order", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const original = { defaultModel: "gpt-6", packages: ["npm:pi-mcp-adapter", "npm:kankaku", "npm:pi-lens"], theme: "Gentleman-Sexy" };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const result = removeKankakuPackage(settingsPath);
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(Object.keys(written), ["defaultModel", "packages", "theme"]);
    assert.deepEqual(written.packages, ["npm:pi-mcp-adapter", "npm:pi-lens"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeKankakuPackage: removes every matching entry (versioned spec and local path) in one pass", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:kankaku@0.8.0", "../../workspace/kankaku", "npm:pi-lens"] }, null, 2));

    const result = removeKankakuPackage(settingsPath);
    assert.equal(result.changed, true);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.packages, ["npm:pi-lens"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeKankakuPackage: is a no-op when kankaku is not present, with no backup and no write", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-lens"] }, null, 2));
    const before = readFileSync(settingsPath, "utf8");

    const result = removeKankakuPackage(settingsPath);
    assert.equal(result.changed, false);
    assert.equal(readFileSync(settingsPath, "utf8"), before);
    assert.equal(existsSync(`${settingsPath}.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeKankakuPackage: backs up the original file to <file>.bak before removing, and never overwrites an existing .bak", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const originalText = JSON.stringify({ packages: ["npm:kankaku"] }, null, 2);
    writeFileSync(settingsPath, originalText);

    removeKankakuPackage(settingsPath);
    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), originalText);

    writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:kankaku"] }, null, 2));
    writeFileSync(`${settingsPath}.bak`, "sentinel");
    removeKankakuPackage(settingsPath);
    assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), "sentinel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addKankakuPackage: leaves a lone npm:kankaku, kankaku-pi, git or object-form entry exactly as it is", () => {
  for (const entry of ["npm:kankaku", "npm:kankaku-pi@^1", "git:github.com/soyunninja/kankaku@v1", { source: "npm:kankaku", extensions: ["!x"] }]) {
    const dir = makeDir();
    try {
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ packages: [entry] }, null, 2));
      const before = readFileSync(settingsPath, "utf8");
      assert.equal(addKankakuPackage(settingsPath).changed, false);
      assert.equal(readFileSync(settingsPath, "utf8"), before);
      assert.equal(existsSync(`${settingsPath}.bak`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("addKankakuPackage: repairs a doubled install, keeping one source by precedence and touching nothing else", () => {
  const cases: { packages: unknown[]; kept: unknown[] }[] = [
    { packages: ["npm:pi-lens", "npm:kankaku", "npm:kankaku-pi", "npm:x"], kept: ["npm:pi-lens", "npm:kankaku-pi", "npm:x"] },
    { packages: ["npm:kankaku-pi", "/dev/kankaku", "git:github.com/soyunninja/kankaku"], kept: ["/dev/kankaku"] },
    { packages: ["npm:kankaku", "git:github.com/soyunninja/kankaku"], kept: ["git:github.com/soyunninja/kankaku"] },
    { packages: [{ source: "npm:kankaku", skills: [] }, { source: "npm:kankaku-pi", extensions: ["!a"] }], kept: [{ source: "npm:kankaku-pi", extensions: ["!a"] }] },
  ];
  for (const { packages, kept } of cases) {
    const dir = makeDir();
    try {
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: "m", packages, theme: "t" }, null, 2));
      assert.equal(addKankakuPackage(settingsPath).changed, true);
      const written = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.deepEqual(written.packages, kept);
      assert.deepEqual(Object.keys(written), ["defaultModel", "packages", "theme"]);
      assert.equal(existsSync(`${settingsPath}.bak`), true);
      assert.equal(addKankakuPackage(settingsPath).changed, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("addKankakuPackage: appends npm:kankaku-pi without destroying object-form entries of other packages", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const other = { source: "npm:pi-lens", skills: [] };
    writeFileSync(settingsPath, JSON.stringify({ packages: [other] }, null, 2));
    assert.equal(addKankakuPackage(settingsPath).changed, true);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).packages, [other, "npm:kankaku-pi"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeKankakuPackage: removes every recognised source, including kankaku-pi, git and object-form entries", () => {
  const dir = makeDir();
  try {
    const settingsPath = join(dir, "settings.json");
    const other = { source: "npm:pi-lens", skills: [] };
    writeFileSync(
      settingsPath,
      JSON.stringify({ packages: ["npm:kankaku-pi", other, { source: "npm:kankaku", extensions: [] }, "git:github.com/soyunninja/kankaku@v1", "/dev/kankaku"] }, null, 2),
    );
    assert.equal(removeKankakuPackage(settingsPath).changed, true);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).packages, [other]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
