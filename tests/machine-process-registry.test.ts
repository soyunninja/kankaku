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
    startedAt: "2026-09-10T16:00:00.000Z",
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
