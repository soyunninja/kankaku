import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { MachineProcessRegistry } from "../src/adapters/machine-process-registry.ts";
import type { RegistryEntry } from "../src/ports/process-registry.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kankaku-registry-"));
});

after(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid: 1000,
    parentPid: 1,
    role: "orchestrator",
    project: "/proj",
    dir: "/proj/.kankaku",
    // "Now" by default (not a fixed past date): most tests here exercise
    // aliveness/identity sweeping, not the separate over-age sweep, and a
    // fixed old timestamp would otherwise make every entry over-age against
    // the real sweep clock (`Date.now()`) once that check exists.
    startedAt: new Date().toISOString(),
    // A default, well-formed identity so tests that don't care about
    // pid-reuse detection aren't inadvertently swept as "unverifiable".
    processStartId: 123456,
    ...overrides,
  };
}

test("record writes an entry file readable back via readAll (SUBAGENT-REQ-009)", () => {
  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 42 }));

  assert.ok(existsSync(join(home, ".kankaku", "run", "42.json")));
  const all = registry.readAll();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.pid, 42);
});

test("record persists a well-formed orchestratorRef", () => {
  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 43, role: "subagent", orchestratorRef: { pid: 42, project: "/proj-a", startedAt: "t" } }));

  const [saved] = registry.readAll();
  assert.deepEqual(saved?.orchestratorRef, { pid: 42, project: "/proj-a", startedAt: "t" });
});

test("readAll returns an empty array when the run directory does not exist yet", () => {
  const registry = new MachineProcessRegistry(() => home);
  assert.deepEqual(registry.readAll(), []);
});

test("readAll tolerates a corrupt entry file, skipping it (SUBAGENT-REQ-009/010)", () => {
  const runDir = join(home, ".kankaku", "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "99.json"), "not json");

  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 100 }));

  const all = registry.readAll();
  assert.deepEqual(
    all.map((e) => e.pid),
    [100],
  );
});

test("readAll tolerates a structurally invalid entry (missing fields), skipping it", () => {
  const runDir = join(home, ".kankaku", "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "77.json"), JSON.stringify({ pid: 77 }));

  const registry = new MachineProcessRegistry(() => home);
  assert.deepEqual(registry.readAll(), []);
});

test("record sweeps a dead-pid entry, but never the one it just wrote (SUBAGENT-REQ-010)", () => {
  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 200 }), () => true); // seed an entry, alive at write time

  // A fresh registry.record() call sweeps others; pid 200 is reported dead now.
  registry.record(entry({ pid: 201 }), (pid) => pid !== 200);

  const pids = registry.readAll().map((e) => e.pid);
  assert.deepEqual(pids.sort(), [201]);
});

test("record leaves a live entry alone during the sweep", () => {
  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 300 }), () => true);
  registry.record(entry({ pid: 301 }), () => true);

  const pids = registry.readAll().map((e) => e.pid);
  assert.deepEqual(pids.sort(), [300, 301]);
});

test("a throwing homeDir provider degrades to 'registry unavailable': record is a no-op, readAll returns []", () => {
  const registry = new MachineProcessRegistry(() => {
    throw new Error("no HOME");
  });

  assert.doesNotThrow(() => registry.record(entry()));
  assert.deepEqual(registry.readAll(), []);
});

test("record persists processStartId, and sweeps a live-but-reused pid as stale (PID-reuse blocker)", () => {
  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 400, processStartId: 1000 }), () => true);

  // pid 400 is still alive, but is now a *different* process instance
  // (different start id) — the registry must not keep trusting it.
  registry.record(entry({ pid: 401, processStartId: 5000 }), () => true, { liveStartId: (pid) => (pid === 400 ? 999_999 : undefined) });

  const pids = registry.readAll().map((e) => e.pid);
  assert.deepEqual(pids.sort(), [401]);
});

test("record keeps a live entry whose start id still matches", () => {
  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 500, processStartId: 1000 }), () => true);
  registry.record(entry({ pid: 501, processStartId: 2000 }), () => true, { liveStartId: (pid) => (pid === 500 ? 1000 : undefined) });

  const pids = registry.readAll().map((e) => e.pid);
  assert.deepEqual(pids.sort(), [500, 501]);
});

test("record sweeps a legacy entry with no processStartId, even though the pid is alive (never trusted, matches malformed-entry cleanup)", () => {
  const runDir = join(home, ".kankaku", "run");
  mkdirSync(runDir, { recursive: true });
  const { processStartId: _omit, ...legacy } = entry({ pid: 600 });
  writeFileSync(join(runDir, "600.json"), JSON.stringify(legacy));

  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 601 }), () => true);

  const pids = registry.readAll().map((e) => e.pid);
  assert.deepEqual(pids.sort(), [601]);
});

test("record sweeps an over-age entry even when alive and identity-verified", () => {
  const registry = new MachineProcessRegistry(() => home);
  const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  registry.record(entry({ pid: 700, processStartId: 1000, startedAt: oldIso }), () => true);
  registry.record(entry({ pid: 701, processStartId: 2000 }), () => true, { liveStartId: (pid) => (pid === 700 ? 1000 : undefined) });

  const pids = registry.readAll().map((e) => e.pid);
  assert.deepEqual(pids.sort(), [701]);
});

test("removeOwn deletes this process's own entry file when pid and processStartId both match what is on disk", () => {
  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 800, processStartId: 1234 }));
  assert.equal(registry.readAll().length, 1);

  registry.removeOwn(800, 1234);
  assert.deepEqual(registry.readAll(), []);
});

test("removeOwn never touches a file whose on-disk identity differs (not verifiably this process's own)", () => {
  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 801, processStartId: 1234 }));

  registry.removeOwn(801, 9999); // wrong processStartId
  assert.equal(registry.readAll().length, 1);

  registry.removeOwn(802, 1234); // wrong pid, no such file
  assert.equal(registry.readAll().length, 1);
});

test("removeOwn is a no-op (never throws) when the registry/home is unavailable or the file is already gone", () => {
  const registry = new MachineProcessRegistry(() => home);
  assert.doesNotThrow(() => registry.removeOwn(999, undefined));

  const unavailable = new MachineProcessRegistry(() => {
    throw new Error("no HOME");
  });
  assert.doesNotThrow(() => unavailable.removeOwn(1, 1));
});
