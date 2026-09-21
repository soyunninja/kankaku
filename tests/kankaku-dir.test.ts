import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveKankakuDir, resolveWritableTarget } from "../src/adapters/kankaku-dir.ts";

const posix = platform() !== "win32";

test("resolveKankakuDir joins a relative dir against the cwd", () => {
  assert.equal(resolveKankakuDir(".kankaku", "/work/project"), "/work/project/.kankaku");
});

test("resolveKankakuDir keeps an absolute dir as-is", () => {
  assert.equal(resolveKankakuDir("/var/kankaku", "/work/project"), "/var/kankaku");
});

test("resolveWritableTarget picks the candidate dir, creating it, when it is writable", () => {
  const base = mkdtempSync(join(tmpdir(), "kankaku-writable-target-"));
  try {
    const candidate = join(base, "parent", ".kankaku");
    const fallback = join(base, "local", ".kankaku");

    const result = resolveWritableTarget(candidate, fallback);

    assert.deepEqual(result, { dir: candidate, usedFallback: false });
    assert.ok(existsSync(candidate));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveWritableTarget falls back to the fallback dir, and marks it, when the candidate probe fails (F1 — parent dir gone/unwritable)", () => {
  const result = resolveWritableTarget("/candidate/does-not-matter", "/fallback/does-not-matter", {
    probe: () => {
      throw new Error("EACCES");
    },
  });

  assert.deepEqual(result, { dir: "/fallback/does-not-matter", usedFallback: true });
});

test("resolveWritableTarget never throws even when both the candidate and the default probe would fail", () => {
  assert.doesNotThrow(() => resolveWritableTarget("/root-only/whatever/.kankaku", "/also/unwritable/.kankaku"));
});

test("resolveWritableTarget's default probe removes a stale write-probe marker (older than a minute) left behind by a SIGKILLed probe (R4)", () => {
  const base = mkdtempSync(join(tmpdir(), "kankaku-writable-target-probe-sweep-"));
  try {
    const candidate = join(base, "candidate", ".kankaku");
    mkdirSync(candidate, { recursive: true });

    const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
    const staleMarker = `.kankaku-write-probe.4242.${twoMinutesAgo}.tmp`;
    writeFileSync(join(candidate, staleMarker), "");

    resolveWritableTarget(candidate, join(base, "fallback", ".kankaku"));

    const remaining = readdirSync(candidate);
    assert.ok(!remaining.includes(staleMarker), "a probe marker older than a minute must be swept away by the next probe run");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveWritableTarget's default probe never touches a fresh write-probe marker (younger than a minute, e.g. a concurrent process's own in-flight probe)", () => {
  const base = mkdtempSync(join(tmpdir(), "kankaku-writable-target-probe-fresh-"));
  try {
    const candidate = join(base, "candidate", ".kankaku");
    mkdirSync(candidate, { recursive: true });

    const tenSecondsAgo = Date.now() - 10 * 1000;
    const freshMarker = `.kankaku-write-probe.4242.${tenSecondsAgo}.tmp`;
    writeFileSync(join(candidate, freshMarker), "");

    resolveWritableTarget(candidate, join(base, "fallback", ".kankaku"));

    const remaining = readdirSync(candidate);
    assert.ok(remaining.includes(freshMarker), "a probe marker younger than a minute must never be touched, even by another process's probe run");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveWritableTarget's default probe actually proves write access, not just directory existence (a read-only existing dir still falls back)", { skip: !posix }, () => {
  const base = mkdtempSync(join(tmpdir(), "kankaku-writable-target-ro-"));
  try {
    const candidate = join(base, "readonly-parent");
    const fallback = join(base, "local", ".kankaku");
    mkdirSync(candidate, { recursive: true, mode: 0o500 });

    const result = resolveWritableTarget(candidate, fallback);

    assert.deepEqual(result, { dir: fallback, usedFallback: true });
  } finally {
    chmodSync(join(base, "readonly-parent"), 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});
