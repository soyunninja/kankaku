import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { computeSyncStatus, runSync, singleFlight } from "../src/adapters/sync-runner.ts";
import { SyncStateStore } from "../src/adapters/sync-state-store.ts";
import type { SyncState } from "../src/domain/sync-plan.ts";
import type { TaskView } from "../src/domain/task-view.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";
import type { WorkLog } from "../src/ports/work-log.ts";
import type { PushOutcome, PushTaskResult, WorkSink } from "../src/ports/work-sink.ts";

function iso(secondsFromEpoch: number): string {
  return new Date(secondsFromEpoch * 1000).toISOString();
}

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/proj",
    prompt: "prompt",
    startedAt: iso(0),
    settledAt: iso(10),
    wallMs: 10000,
    waitingMs: 0,
    workMs: 10000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    status: "completed",
    ...overrides,
  };
}

/** `version`, when given, is exposed as `WorkLog#version()`; `readAllCalls` counts `readAll()` invocations so a test can prove the automatic short-circuit truly skipped reading the log. */
function fakeLog(records: WorkRecord[], version?: string | number): WorkLog & { readAllCalls: number } {
  let readAllCalls = 0;
  const log: WorkLog & { readAllCalls: number } = {
    append: () => {},
    readAll: () => {
      readAllCalls += 1;
      return records;
    },
    get readAllCalls() {
      return readAllCalls;
    },
  };
  if (version !== undefined) {
    log.version = () => version;
  }
  return log;
}

/** A fake sink driven by a per-task outcome map; records every call for assertions. */
function fakeSink(outcomes: Record<string, PushOutcome>, stopAt?: string): { sink: WorkSink; calls: TaskView[][] } {
  const calls: TaskView[][] = [];
  return {
    calls,
    sink: {
      async push(tasks: TaskView[]): Promise<PushTaskResult[]> {
        calls.push(tasks);
        const results: PushTaskResult[] = [];
        for (const task of tasks) {
          const outcome = outcomes[task.id] ?? { kind: "created", unassigned: false };
          results.push({ taskId: task.id, outcome });
          if (task.id === stopAt || outcome.kind === "error") break;
        }
        return results;
      },
    },
  };
}

/** In-memory fake replacing SyncStateStore for these tests (avoids filesystem I/O). */
function fakeStateStore(initial?: SyncState) {
  let state = initial;
  let locked = false;
  return {
    read: () => state,
    write: (next: SyncState) => {
      state = next;
    },
    tryLock: () => {
      if (locked) return false;
      locked = true;
      return true;
    },
    unlock: () => {
      locked = false;
    },
    // test helpers
    _setLocked: (value: boolean) => {
      locked = value;
    },
    _state: () => state,
  };
}

function makeClock(startMs = 1_000_000) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const TARGET = "https://pb.example.com";

test("a run with no pending tasks uploads nothing and reports an empty summary", async () => {
  const { sink } = fakeSink({});
  const stateStore = fakeStateStore();
  const clock = makeClock();

  const summary = await runSync({ log: fakeLog([]), sink, stateStore: stateStore as never, clock, target: TARGET });

  assert.equal(summary.uploaded, 0);
  assert.equal(summary.updated, 0);
  assert.equal(summary.failed.length, 0);
  assert.deepEqual(summary.unassigned, {});
  assert.equal(summary.syncedThrough, undefined);
});

test("an uncertain-flagged orchestrator record is never synced as its own task (SUBAGENT-REQ-014)", async () => {
  const uncertain = makeRecord({ id: "p1", roleConfidence: "uncertain" });
  const { sink, calls } = fakeSink({});
  const stateStore = fakeStateStore();
  const clock = makeClock();

  const summary = await runSync({ log: fakeLog([uncertain]), sink, stateStore: stateStore as never, clock, target: TARGET });

  assert.equal(summary.uploaded, 0);
  assert.deepEqual(calls, [[]]); // buildTasks produced zero tasks; the sink was called with an empty array
});

test("a successful sync uploads every candidate task and advances syncedThrough to the latest endedAt", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const { sink } = fakeSink({ "task-1": { kind: "created", unassigned: false } });
  const stateStore = fakeStateStore();
  const clock = makeClock();

  const summary = await runSync({ log: fakeLog([orchestrator]), sink, stateStore: stateStore as never, clock, target: TARGET });

  assert.equal(summary.uploaded, 1);
  assert.equal(summary.syncedThrough, iso(10));
  assert.ok(stateStore._state()?.hashes["task-1"]);
});

test("running sync again with unchanged tasks performs zero writes (skipped, not uploaded)", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const clock = makeClock();
  const stateStore = fakeStateStore();

  const first = fakeSink({ "task-1": { kind: "created", unassigned: false } });
  await runSync({ log: fakeLog([orchestrator]), sink: first.sink, stateStore: stateStore as never, clock, target: TARGET });

  const second = fakeSink({});
  const summary = await runSync({ log: fakeLog([orchestrator]), sink: second.sink, stateStore: stateStore as never, clock, target: TARGET });

  assert.equal(summary.uploaded, 0);
  assert.equal(summary.updated, 0);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(second.calls, [[]]); // push was called with an empty array: nothing needed a request.
});

test("a network/systemic error stops the run and does not advance syncedThrough past the failing task", async () => {
  const first = makeRecord({ id: "t1", startedAt: iso(0), settledAt: iso(10) });
  const second = makeRecord({ id: "t2", startedAt: iso(20), settledAt: iso(30) });
  const { sink } = fakeSink({ "t2": { kind: "error", reason: "network down" } });
  const stateStore = fakeStateStore();
  const clock = makeClock();

  const summary = await runSync({ log: fakeLog([first, second]), sink, stateStore: stateStore as never, clock, target: TARGET });

  assert.equal(summary.uploaded, 1); // t1 succeeded
  assert.equal(summary.syncedThrough, iso(10)); // not advanced past t2
  assert.equal(summary.error, "network down");
  assert.equal(stateStore._state()?.lastError?.message, "network down");
});

test("a run against a different target that resolves nothing does not overwrite the persisted target (regression)", async () => {
  // A sync attempted against a new/unreachable target that fails on its
  // very first task must not persist that target as the state's `target`:
  // otherwise a later sync back against the *real*, working target would
  // see state.target === options.target and wrongly skip the full
  // re-evaluation it needs after the aborted attempt.
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const stateStore = fakeStateStore({ target: TARGET, syncedThrough: iso(10), hashes: { "task-1": "some-hash" } });
  const clock = makeClock();
  const { sink } = fakeSink({ "task-1": { kind: "error", reason: "connection refused" } });

  const summary = await runSync({ log: fakeLog([orchestrator]), sink, stateStore: stateStore as never, clock, target: "https://unreachable.example.com" });

  assert.equal(summary.error, "connection refused");
  assert.equal(stateStore._state()?.target, TARGET, "target must remain the last one actually synced against");
});

test("a run against a new target that does resolve at least one task adopts that target", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const stateStore = fakeStateStore({ target: TARGET, syncedThrough: iso(10), hashes: {} });
  const clock = makeClock();
  const { sink } = fakeSink({ "task-1": { kind: "updated", unassigned: false } });

  await runSync({ log: fakeLog([orchestrator]), sink, stateStore: stateStore as never, clock, target: "https://new.example.com" }, { full: true });

  assert.equal(stateStore._state()?.target, "https://new.example.com");
});

test("a validation failure is recorded in failed[] and does not stop later tasks or block syncedThrough", async () => {
  const bad = makeRecord({ id: "bad", startedAt: iso(0), settledAt: iso(10) });
  const good = makeRecord({ id: "good", startedAt: iso(20), settledAt: iso(30) });
  const { sink } = fakeSink({ bad: { kind: "failed", reason: "missing required field" } });
  const stateStore = fakeStateStore();
  const clock = makeClock();

  const summary = await runSync({ log: fakeLog([bad, good]), sink, stateStore: stateStore as never, clock, target: TARGET });

  assert.deepEqual(summary.failed, [{ id: "bad", reason: "missing required field" }]);
  assert.equal(summary.uploaded, 1);
  assert.equal(summary.syncedThrough, iso(30));
});

test("tasks routed to the unassigned client are grouped by legacy label in the summary", async () => {
  const a = makeRecord({ id: "a", startedAt: iso(0), settledAt: iso(10) });
  const b = makeRecord({ id: "b", startedAt: iso(20), settledAt: iso(30) });
  const c = makeRecord({ id: "c", startedAt: iso(40), settledAt: iso(50) });
  const { sink } = fakeSink({
    a: { kind: "created", unassigned: true, legacyLabel: "cajamar" },
    b: { kind: "created", unassigned: true, legacyLabel: "cajamar" },
    c: { kind: "created", unassigned: true, legacyLabel: "otra-empresa" },
  });
  const stateStore = fakeStateStore();
  const clock = makeClock();

  const summary = await runSync({ log: fakeLog([a, b, c]), sink, stateStore: stateStore as never, clock, target: TARGET });

  assert.deepEqual(summary.unassigned, { cajamar: 2, "otra-empresa": 1 });
});

test("a legacy label literally named '__proto__' is tracked as an own property, not silently dropped by an inherited-property collision", async () => {
  const a = makeRecord({ id: "a", startedAt: iso(0), settledAt: iso(10) });
  const b = makeRecord({ id: "b", startedAt: iso(20), settledAt: iso(30) });
  const { sink } = fakeSink({
    a: { kind: "created", unassigned: true, legacyLabel: "__proto__" },
    b: { kind: "created", unassigned: true, legacyLabel: "constructor" },
  });
  const stateStore = fakeStateStore();
  const clock = makeClock();

  const summary = await runSync({ log: fakeLog([a, b]), sink, stateStore: stateStore as never, clock, target: TARGET });

  assert.deepEqual(summary.unassigned, JSON.parse('{"__proto__":1,"constructor":1}'));
  assert.equal(Object.getPrototypeOf(summary.unassigned), Object.prototype);
});

test("a task id literally named '__proto__' produces a hash entry that survives as an own property in the persisted state", async () => {
  const orchestrator = makeRecord({ id: "__proto__", startedAt: iso(0), settledAt: iso(10) });
  const { sink } = fakeSink({ "__proto__": { kind: "created", unassigned: false } });
  const stateStore = fakeStateStore();
  const clock = makeClock();

  await runSync({ log: fakeLog([orchestrator]), sink, stateStore: stateStore as never, clock, target: TARGET });

  const hashes = stateStore._state()?.hashes ?? {};
  assert.ok(Object.prototype.hasOwnProperty.call(hashes, "__proto__"));
  assert.equal(typeof hashes["__proto__"], "string");
});

test("a late subagent extending a previously-synced task's union causes it to be pushed again as an update", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const stateStore = fakeStateStore();
  const clock = makeClock();

  const first = fakeSink({ "task-1": { kind: "created", unassigned: false } });
  await runSync({ log: fakeLog([orchestrator]), sink: first.sink, stateStore: stateStore as never, clock, target: TARGET, windowHours: 24 });

  // A background subagent settles later, extending the task's union.
  const child = makeRecord({ id: "child-1", role: "subagent", pid: 2, parentPid: 1, startedAt: iso(5), settledAt: iso(40) });
  const second = fakeSink({ "task-1": { kind: "updated", unassigned: false } });
  const summary = await runSync({
    log: fakeLog([orchestrator, child]),
    sink: second.sink,
    stateStore: stateStore as never,
    clock,
    target: TARGET,
    windowHours: 24,
  });

  assert.equal(summary.updated, 1);
  assert.equal(summary.uploaded, 0);
});

test("when the lock cannot be acquired, nothing is attempted and the summary reports locked", async () => {
  const { sink, calls } = fakeSink({});
  const stateStore = fakeStateStore();
  stateStore._setLocked(true);
  const clock = makeClock();

  const summary = await runSync({ log: fakeLog([]), sink, stateStore: stateStore as never, clock, target: TARGET });

  assert.equal(summary.locked, true);
  assert.equal(calls.length, 0);
});

test("a state synced against a different hub URL triggers a full sync (every task re-evaluated)", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const staleState: SyncState = { target: "https://old.example.com", syncedThrough: iso(999999), hashes: { "task-1": "stale-hash" } };
  const stateStore = fakeStateStore(staleState);
  const clock = makeClock();
  const { sink } = fakeSink({ "task-1": { kind: "updated", unassigned: false } });

  const summary = await runSync({ log: fakeLog([orchestrator]), sink, stateStore: stateStore as never, clock, target: TARGET });

  assert.equal(summary.updated, 1);
  assert.equal(stateStore._state()?.target, TARGET);
});

test("durationMs reflects the injected clock, not wall-clock time", async () => {
  const { sink } = fakeSink({});
  const stateStore = fakeStateStore();
  const clock = makeClock(0);
  clock.advance(1234);
  const originalNow = clock.now;
  let calls = 0;
  const clockWithAdvance = {
    now: () => {
      calls += 1;
      return calls === 1 ? 0 : 1234;
    },
  };

  const summary = await runSync({ log: fakeLog([]), sink, stateStore: stateStore as never, clock: clockWithAdvance, target: TARGET });
  assert.equal(summary.durationMs, 1234);
  void originalNow;
});

test("never throws even when the sink itself throws", async () => {
  const orchestrator = makeRecord({ id: "task-1" });
  const throwingSink: WorkSink = {
    push: async () => {
      throw new Error("boom");
    },
  };
  const stateStore = fakeStateStore();
  const clock = makeClock();

  const summary = await runSync({ log: fakeLog([orchestrator]), sink: throwingSink, stateStore: stateStore as never, clock, target: TARGET });

  assert.equal(summary.error, "boom");
});

// --- Automatic path: version short-circuit and throttle (finding 2) ---

test("the automatic path skips entirely (no readAll, no push) when the log version is unchanged since the last successful sync", async () => {
  const log = fakeLog([], "v1");
  const { sink, calls } = fakeSink({});
  const stateStore = fakeStateStore({ target: TARGET, hashes: {}, logVersion: "v1", lastRunAt: 1_000_000 });
  const clock = makeClock(2_000_000); // well past any throttle window, irrelevant here

  const summary = await runSync({ log, sink, stateStore: stateStore as never, clock, target: TARGET }, { trigger: "agent_settled" });

  assert.equal(log.readAllCalls, 0);
  assert.equal(calls.length, 0);
  assert.equal(summary.error, undefined);
});

test("the automatic path does not short-circuit when the last recorded attempt errored, even if the version is unchanged", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const log = fakeLog([orchestrator], "v1");
  const { sink } = fakeSink({ "task-1": { kind: "created", unassigned: false } });
  const stateStore = fakeStateStore({
    target: TARGET,
    hashes: {},
    logVersion: "v1",
    lastRunAt: 1_000_000,
    lastError: { message: "boom", at: iso(0) },
  });
  const clock = makeClock(2_000_000);

  const summary = await runSync(
    { log, sink, stateStore: stateStore as never, clock, target: TARGET, minAutoIntervalMs: 0 },
    { trigger: "session_start" },
  );

  assert.equal(log.readAllCalls, 1);
  assert.equal(summary.uploaded, 1);
});

test("the automatic path is throttled: right after a record was appended (version changed), a second trigger within the interval does not run again", async () => {
  // Mirrors what actually happens after agent_settled: the log version
  // WILL have changed (a record was just appended), so the version
  // short-circuit alone cannot protect against re-reading on every prompt.
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const log = fakeLog([orchestrator], "v2");
  const { sink, calls } = fakeSink({});
  const stateStore = fakeStateStore({ target: TARGET, hashes: {}, logVersion: "v1", lastRunAt: 1_000_000 });
  const clock = makeClock(1_000_100); // 100ms later, well within the default 5-minute throttle

  const summary = await runSync({ log, sink, stateStore: stateStore as never, clock, target: TARGET }, { trigger: "agent_settled" });

  assert.equal(log.readAllCalls, 0);
  assert.equal(calls.length, 0);
  assert.equal(summary.error, undefined);
});

test("session_start bypasses the throttle when the last automatic run errored", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const log = fakeLog([orchestrator], "v2");
  const { sink } = fakeSink({ "task-1": { kind: "created", unassigned: false } });
  const stateStore = fakeStateStore({
    target: TARGET,
    hashes: {},
    logVersion: "v1",
    lastRunAt: 1_000_000,
    lastError: { message: "network down", at: iso(0) },
  });
  const clock = makeClock(1_000_100); // within the throttle window

  const summary = await runSync({ log, sink, stateStore: stateStore as never, clock, target: TARGET }, { trigger: "session_start" });

  assert.equal(log.readAllCalls, 1);
  assert.equal(summary.uploaded, 1);
});

test("agent_settled (unlike session_start) does not get an error bypass: it stays throttled within the interval even after a previous error", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const log = fakeLog([orchestrator], "v2");
  const { sink, calls } = fakeSink({});
  const stateStore = fakeStateStore({
    target: TARGET,
    hashes: {},
    logVersion: "v1",
    lastRunAt: 1_000_000,
    lastError: { message: "network down", at: iso(0) },
  });
  const clock = makeClock(1_000_100);

  const summary = await runSync({ log, sink, stateStore: stateStore as never, clock, target: TARGET }, { trigger: "agent_settled" });

  assert.equal(log.readAllCalls, 0);
  assert.equal(calls.length, 0);
  assert.equal(summary.error, undefined);
});

test("an automatic trigger is never throttled when there is no previous run at all", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const log = fakeLog([orchestrator], "v1");
  const { sink } = fakeSink({ "task-1": { kind: "created", unassigned: false } });
  const stateStore = fakeStateStore(); // no prior state at all
  const clock = makeClock();

  const summary = await runSync({ log, sink, stateStore: stateStore as never, clock, target: TARGET }, { trigger: "session_start" });

  assert.equal(log.readAllCalls, 1);
  assert.equal(summary.uploaded, 1);
});

test("a manual sync.run() call (no trigger) ignores both the version short-circuit and the throttle", async () => {
  const log = fakeLog([], "v1"); // unchanged version
  const { sink, calls } = fakeSink({});
  const stateStore = fakeStateStore({ target: TARGET, hashes: {}, logVersion: "v1", lastRunAt: 1_000_000 });
  const clock = makeClock(1_000_050); // well within the throttle window

  const summary = await runSync({ log, sink, stateStore: stateStore as never, clock, target: TARGET }); // no options.trigger: manual

  assert.equal(log.readAllCalls, 1);
  assert.deepEqual(calls, [[]]); // push was still called, just with nothing pending
  void summary;
});

test("minAutoIntervalMs: 0 disables the automatic throttle entirely", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const log = fakeLog([orchestrator], "v2");
  const { sink } = fakeSink({ "task-1": { kind: "created", unassigned: false } });
  const stateStore = fakeStateStore({ target: TARGET, hashes: {}, logVersion: "v1", lastRunAt: 1_000_000 });
  const clock = makeClock(1_000_001); // 1ms later

  const summary = await runSync(
    { log, sink, stateStore: stateStore as never, clock, target: TARGET, minAutoIntervalMs: 0 },
    { trigger: "agent_settled" },
  );

  assert.equal(summary.uploaded, 1);
});

test("a completed automatic run persists logVersion (as read for this run) and lastRunAt", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const log = fakeLog([orchestrator], "v-after-read");
  const { sink } = fakeSink({ "task-1": { kind: "created", unassigned: false } });
  const stateStore = fakeStateStore();
  const clock = makeClock(5_000_000);

  await runSync({ log, sink, stateStore: stateStore as never, clock, target: TARGET }, { trigger: "session_start" });

  assert.equal(stateStore._state()?.logVersion, "v-after-read");
  assert.equal(stateStore._state()?.lastRunAt, 5_000_000);
});

test("an automatic run that errors still persists lastRunAt and logVersion, so the throttle window starts from this attempt", async () => {
  const first = makeRecord({ id: "t1", startedAt: iso(0), settledAt: iso(10) });
  const log = fakeLog([first], "v-err");
  const { sink } = fakeSink({ t1: { kind: "error", reason: "network down" } });
  const stateStore = fakeStateStore();
  const clock = makeClock(7_000_000);

  await runSync({ log, sink, stateStore: stateStore as never, clock, target: TARGET }, { trigger: "agent_settled" });

  assert.equal(stateStore._state()?.lastRunAt, 7_000_000);
  assert.equal(stateStore._state()?.logVersion, "v-err");
  assert.equal(stateStore._state()?.lastError?.message, "network down");
});

test("a manual sync run also persists lastRunAt and logVersion (so a later automatic trigger can still short-circuit/throttle against it)", async () => {
  const orchestrator = makeRecord({ id: "task-1", startedAt: iso(0), settledAt: iso(10) });
  const log = fakeLog([orchestrator], "v-manual");
  const { sink } = fakeSink({ "task-1": { kind: "created", unassigned: false } });
  const stateStore = fakeStateStore();
  const clock = makeClock(9_000_000);

  await runSync({ log, sink, stateStore: stateStore as never, clock, target: TARGET }); // manual: no trigger

  assert.equal(stateStore._state()?.lastRunAt, 9_000_000);
  assert.equal(stateStore._state()?.logVersion, "v-manual");
});

let statusDir: string;

after(() => {
  if (statusDir) rmSync(statusDir, { recursive: true, force: true });
});

test("computeSyncStatus reports the persisted state and a locally-computed pending count, with no network", () => {
  statusDir = mkdtempSync(join(tmpdir(), "kankaku-sync-status-"));
  const stateStore = new SyncStateStore({ dir: statusDir, pid: 1 });
  const pending = makeRecord({ id: "pending-task", startedAt: iso(0), settledAt: iso(10) });
  const log = fakeLog([pending]);

  const before = computeSyncStatus(log, stateStore, TARGET);
  assert.equal(before.state, undefined);
  assert.equal(before.pending, 1);
  assert.equal(before.staleOutsideWindow, 0);

  stateStore.write({ target: TARGET, syncedThrough: iso(10), hashes: {} });
  const after = computeSyncStatus(log, stateStore, TARGET);
  assert.equal(after.state?.syncedThrough, iso(10));
});

test("computeSyncStatus (R3): reports staleOutsideWindow — tasks changed since their last sync but outside this run's revisit window", () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-sync-status-stale-"));
  try {
    const stateStore = new SyncStateStore({ dir, pid: 1 });
    // A task that ended long ago (outside the 24h default window behind a
    // watermark far in the future) with a hash that no longer matches its
    // current content — as if a background subagent joined it after the
    // watermark had already advanced well past it (R3).
    const task = makeRecord({ id: "late-join-task", startedAt: iso(0), settledAt: iso(10) });
    const log = fakeLog([task]);

    stateStore.write({ target: TARGET, syncedThrough: iso(100_000_000), hashes: { "late-join-task": "stale-hash-from-before-the-child-joined" } });

    const status = computeSyncStatus(log, stateStore, TARGET);
    assert.equal(status.pending, 0, "an ordinary incremental sync must not re-evaluate it");
    assert.equal(status.staleOutsideWindow, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("singleFlight: concurrent calls while one is in flight join the same result instead of starting a new run", async () => {
  let calls = 0;
  let resolveFirst!: (value: number) => void;
  const wrapped = singleFlight(async () => {
    calls += 1;
    return new Promise<number>((resolve) => {
      resolveFirst = resolve;
    });
  });

  const first = wrapped();
  const second = wrapped(); // arrives while the first is still in flight

  assert.equal(calls, 1); // the second call did not start a new run

  resolveFirst(42);
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
});

test("singleFlight: a call after the previous one resolved starts a fresh run", async () => {
  let calls = 0;
  const wrapped = singleFlight(async () => {
    calls += 1;
    return calls;
  });

  assert.equal(await wrapped(), 1);
  assert.equal(await wrapped(), 2);
  assert.equal(calls, 2);
});
