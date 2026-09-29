import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { MachineProcessRegistry } from "../src/adapters/machine-process-registry.ts";
import type { RegistryEntry } from "../src/ports/process-registry.ts";

/** File-mode bits are a POSIX concept; skip mode assertions on a platform where they are not meaningful (e.g. Windows). */
const posix = platform() !== "win32";

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

test("record keeps a live legacy entry with no processStartId — unverifiable is never itself grounds for deletion (F4)", () => {
  const runDir = join(home, ".kankaku", "run");
  mkdirSync(runDir, { recursive: true });
  const { processStartId: _omit, ...legacy } = entry({ pid: 600 });
  writeFileSync(join(runDir, "600.json"), JSON.stringify(legacy));

  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 601 }), () => true);

  const pids = registry.readAll().map((e) => e.pid);
  assert.deepEqual(pids.sort(), [600, 601]);
});

test("record still sweeps a dead legacy entry with no processStartId (dead pids are cleaned regardless of identity verifiability)", () => {
  const runDir = join(home, ".kankaku", "run");
  mkdirSync(runDir, { recursive: true });
  const { processStartId: _omit, ...legacy } = entry({ pid: 600 });
  writeFileSync(join(runDir, "600.json"), JSON.stringify(legacy));

  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 601 }), (pid) => pid !== 600);

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

test("record creates ~/.kankaku/run with mode 0o700 and an entry file with mode 0o600 (F4)", { skip: !posix }, () => {
  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 900 }));

  const runDir = join(home, ".kankaku", "run");
  assert.equal(statSync(runDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(runDir, "900.json")).mode & 0o777, 0o600);
});

test("record tightens an existing looser run directory mode (best effort, never throws)", { skip: !posix }, () => {
  const runDir = join(home, ".kankaku", "run");
  mkdirSync(runDir, { recursive: true, mode: 0o755 });
  assert.equal(statSync(runDir).mode & 0o777, 0o755);

  const registry = new MachineProcessRegistry(() => home);
  assert.doesNotThrow(() => registry.record(entry({ pid: 901 })));

  assert.equal(statSync(runDir).mode & 0o777, 0o700);
});

test("record tightens an existing looser entry file mode left by a prior build (best effort)", { skip: !posix }, () => {
  const runDir = join(home, ".kankaku", "run");
  mkdirSync(runDir, { recursive: true });
  const target = join(runDir, "902.json");
  writeFileSync(target, JSON.stringify(entry({ pid: 902 })), { mode: 0o644 });
  assert.equal(statSync(target).mode & 0o777, 0o644);

  const registry = new MachineProcessRegistry(() => home);
  // A fresh record() for a different pid sweeps/re-touches the directory;
  // it must tighten a looser sibling file's mode as a best-effort side
  // effect without throwing, even though it does not own that entry.
  assert.doesNotThrow(() => registry.record(entry({ pid: 903 }), () => true));

  assert.equal(statSync(target).mode & 0o777, 0o600);
});

test("sweep re-reads an entry's raw bytes immediately before unlinking, and skips deletion when they no longer match what was judged stale (TOCTOU / pid-reuse-during-sweep, F4)", () => {
  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 700, processStartId: 1000 }), () => true); // seed, alive at write time
  const path = join(home, ".kankaku", "run", "700.json");

  const racedEntry = entry({ pid: 700, processStartId: 9_999_999, project: "/new-owner", startedAt: new Date().toISOString() });

  // A fresh record() sweep judges pid 700 dead from its own directory
  // snapshot, but — simulated via isAlive's side effect, since everything
  // else in this call is synchronous — the OS has, in the meantime, reused
  // pid 700 for a brand new process that already wrote its own fresh entry
  // to the very same file.
  registry.record(entry({ pid: 701 }), (pid) => {
    if (pid === 700) {
      writeFileSync(path, JSON.stringify(racedEntry));
      return false;
    }
    return true;
  });

  const onDisk: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(onDisk, racedEntry); // never unlinked: the raced-in entry survives byte-for-byte
});

test("sweep still deletes a discarded entry normally when nothing raced it (no false negative from the TOCTOU guard)", () => {
  const registry = new MachineProcessRegistry(() => home);
  registry.record(entry({ pid: 710 }), () => true);
  registry.record(entry({ pid: 711 }), (pid) => pid !== 710);

  assert.deepEqual(
    registry.readAll().map((e) => e.pid),
    [711],
  );
});
