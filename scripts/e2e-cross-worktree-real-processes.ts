#!/usr/bin/env node
/**
 * Opt-in, REAL-OS-PROCESS proof of F1's cross-worktree write routing (ADR
 * 0023's rewrite): a parent node process `spawnSync`s a real child node
 * process — blocking, exactly mirroring gentle-pi's main case, a
 * `subagent_run` call in task mode — with a temp `HOME` (so
 * `~/.kankaku/run/`  is isolated) and two temp "worktree" cwds.
 *
 * This reproduces the real ordering an independent review proved with a
 * real `spawnSync` parent/child script: the child registers itself, walks
 * its OWN real OS ancestor chain (a genuine `ps`/`/proc` read — this is
 * exactly what a unit test fakes and therefore cannot prove), resolves its
 * orchestrator's directory, writes its OWN `WorkRecord` straight into THAT
 * directory (F1), then exits — which runs its real `process.on("exit")`
 * cleanup and removes its own registry entry — all BEFORE the parent
 * regains control (`spawnSync` blocks). By the time the parent looks, the
 * child's registry entry is provably gone, yet the child's record is
 * already sitting in the parent's own `worklog.jsonl`: reunification never
 * depended on that pointer still existing.
 *
 * Also cross-checks F5's own-start-identity shortcut (`ownStartIdFromUptime`,
 * `now - uptime`) against a real `ps`/`/proc`-derived reading of the SAME
 * process, taken independently by the other side (the child re-derives the
 * parent's start id from a real ancestry snapshot) — they must agree within
 * `START_ID_TOLERANCE_MS`, proving the two independent methods really do
 * describe the same process instance rather than just happening to pass in
 * a fake unit test.
 *
 * A second scenario (`runConcurrencyStress`) then spawns several real
 * writer processes CONCURRENTLY (not sequentially), all appending
 * realistically large records into the same `worklog.jsonl`, and reads the
 * raw file back to prove `jsonl-work-log.ts`'s single-`appendFileSync`
 * atomicity claim under genuine OS-level concurrency, not just sequential
 * in-process calls.
 *
 * NOT part of `npm test`/`npm run check` (no real child processes in unit
 * tests, per AGENTS.md) — opt-in via `npm run e2e:cross-worktree` or a
 * direct `node scripts/e2e-cross-worktree-real-processes.ts`. Always
 * removes its scratch directory, even on failure.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { detectRole, readRoleOverride, stripRoleOverride } from "../src/config.ts";
import { resolveOrchestratorRef, START_ID_TOLERANCE_MS } from "../src/domain/ancestry-match.ts";
import type { OrchestratorRef, WorkRecord } from "../src/domain/work-record.ts";
import { MachineProcessRegistry } from "../src/adapters/machine-process-registry.ts";
import { resolveSubagentStartup } from "../src/adapters/subagent-startup.ts";
import { resolveKankakuDir, resolveWritableTarget } from "../src/adapters/kankaku-dir.ts";
import { JsonlWorkLog } from "../src/adapters/jsonl-work-log.ts";
import { createProcessIdentityMemo } from "../src/adapters/process-identity-memo.ts";

const THIS_SCRIPT = fileURLToPath(import.meta.url);

function iso(msFromEpoch: number): string {
  return new Date(msFromEpoch).toISOString();
}

function makeRecord(overrides: Partial<WorkRecord> & Pick<WorkRecord, "id" | "pid" | "parentPid" | "role" | "project">): WorkRecord {
  return {
    schema: 1,
    prompt: "real-process e2e prompt for " + overrides.id,
    startedAt: iso(0),
    settledAt: iso(1000),
    wallMs: 1000,
    waitingMs: 0,
    workMs: 1000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    status: "completed",
    ...overrides,
  };
}

/**
 * Mirrors `extension.ts`'s startup block exactly (minus pi's own event
 * wiring), so this script exercises the REAL mechanism it will actually run
 * in production — not a re-implementation of it that could quietly drift
 * from the real one.
 */
function runStartup(homeDir: string, cwd: string): { registry: MachineProcessRegistry; role: "orchestrator" | "subagent"; orchestratorRef: OrchestratorRef | undefined; resolvedDir: string; ownProcessStartId: number } {
  const registry = new MachineProcessRegistry(() => homeDir);
  const startup = resolveSubagentStartup({
    registry,
    ppid: process.ppid,
    now: () => Date.now(),
    uptimeSeconds: () => process.uptime(),
  });
  // Mirrors extension.ts's real R1 fix exactly: a synchronous TTY-based
  // interactivity guess, then strip KANKAKU_ROLE from this process's own
  // env right after reading it, so a real child this process spawns below
  // never inherits it.
  const { role } = detectRole(process.env, false, Boolean(process.stdout.isTTY));
  stripRoleOverride(process.env);
  const orchestratorRef = role === "subagent" ? resolveOrchestratorRef(startup.ancestorEntry) : undefined;
  const resolvedDir = resolveKankakuDir(".kankaku", cwd);

  registry.record(
    {
      pid: process.pid,
      parentPid: process.ppid,
      role,
      project: cwd,
      dir: resolvedDir,
      startedAt: new Date().toISOString(),
      ...(orchestratorRef !== undefined ? { orchestratorRef } : {}),
      processStartId: startup.ownProcessStartId,
    },
    undefined,
    { liveStartId: startup.liveStartId },
  );

  process.on("exit", () => {
    registry.removeOwn?.(process.pid, startup.ownProcessStartId);
  });

  return { registry, role, orchestratorRef, resolvedDir, ownProcessStartId: startup.ownProcessStartId };
}

function runChild(): void {
  const homeDir = process.env["KANKAKU_E2E_HOME"];
  const childCwd = process.env["KANKAKU_E2E_CHILD_CWD"];
  if (!homeDir || !childCwd) throw new Error("child requires KANKAKU_E2E_HOME and KANKAKU_E2E_CHILD_CWD");

  const registry = new MachineProcessRegistry(() => homeDir);
  const startupForCrossCheck = resolveSubagentStartup({
    registry,
    ppid: process.ppid,
    now: () => Date.now(),
    uptimeSeconds: () => process.uptime(),
  });
  // F5 cross-check: this process's OWN real ps/proc-derived reading of the
  // PARENT's start identity (from a real ancestry snapshot this process
  // just took), printed as a machine-parseable line so the parent can
  // compare it against its own uptime-derived `ownProcessStartId` — proving
  // the two independent methods describe the same process instance, in a
  // real environment (see `adapters/ancestry.ts#ownStartIdFromUptime`).
  const parentLiveStartIdSeenByChild = startupForCrossCheck.liveStartId(process.ppid);
  console.log(`PARENT_LIVE_START_ID_SEEN_BY_CHILD=${parentLiveStartIdSeenByChild}`);

  const { role, orchestratorRef, resolvedDir } = runStartup(homeDir, childCwd);
  assert.equal(role, "subagent", "the child process must classify as subagent (GENTLE_PI_AGENTS_CHILD=1)");
  assert.ok(orchestratorRef, "the child must have discovered a verified orchestratorRef via the real ancestor chain");
  assert.ok(orchestratorRef!.dir, "the discovered orchestratorRef must carry the parent's kankaku dir (F1 routing target)");

  // F1: route this process's own work log into the orchestrator's
  // directory when it differs from this process's own.
  const target = orchestratorRef!.dir !== resolvedDir ? resolveWritableTarget(orchestratorRef!.dir, resolvedDir).dir : resolvedDir;

  const log = new JsonlWorkLog(target);
  log.append(
    makeRecord({
      id: "child-task",
      role: "subagent",
      pid: process.pid,
      parentPid: process.ppid,
      project: childCwd,
      orchestratorRef: orchestratorRef!,
      startedAt: iso(Date.now()),
      settledAt: iso(Date.now() + 100),
    }),
  );

  // eslint-disable-next-line no-console
  console.log(`[child pid=${process.pid}] wrote its record into: ${target}`);
  // A normal exit — never a signal — so `process.on("exit")` above runs and
  // removes this process's own registry entry, exactly like a real
  // gentle-pi task-mode subagent finishing its run.
  process.exit(0);
}

async function runParent(): Promise<void> {
  const scratchRoot = process.env["KANKAKU_E2E_SCRATCH"] ?? tmpdir();
  mkdirSync(scratchRoot, { recursive: true });
  const runDir = mkdtempSync(join(scratchRoot, "kankaku-e2e-real-proc-"));
  const homeDir = join(runDir, "home");
  const worktreeA = join(runDir, "worktree-a");
  const worktreeB = join(runDir, "worktree-b");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(worktreeA, { recursive: true });
  mkdirSync(worktreeB, { recursive: true });

  try {
    console.log(`[parent pid=${process.pid}] scratch dir: ${runDir}`);

    const parent = runStartup(homeDir, worktreeA);
    assert.equal(parent.role, "orchestrator", "the parent (no env marker, no tracked ancestor of its own) must be a confirmed orchestrator");
    assert.equal(parent.orchestratorRef, undefined);

    const parentEntryPath = join(homeDir, ".kankaku", "run", `${process.pid}.json`);
    assert.ok(existsSync(parentEntryPath), "the parent's own registry entry must exist on disk before spawning the child");
    console.log(`[parent] registered at ${parentEntryPath}, own start id (uptime-derived): ${parent.ownProcessStartId}`);

    console.log("[parent] spawning a REAL child process, BLOCKING (spawnSync — mirrors gentle-pi's task-mode subagent_run)...");
    const result = spawnSync(process.execPath, [THIS_SCRIPT, "--child"], {
      cwd: worktreeB,
      env: {
        ...process.env,
        GENTLE_PI_AGENTS_CHILD: "1",
        KANKAKU_E2E_HOME: homeDir,
        KANKAKU_E2E_CHILD_CWD: worktreeB,
      },
      encoding: "utf8",
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    assert.equal(result.status, 0, `the child process must exit 0 (status=${result.status}, error=${result.error})`);
    console.log("[parent] child process has exited; spawnSync has returned control.");

    // THE KEY ASSERTION (the bug this whole finding is about): by the time
    // we get here, the child has ALREADY run its own exit cleanup — its
    // registry entry must be provably gone.
    const stillRegistered = parent.registry.readAll().some((entry) => entry.role === "subagent" && entry.project === worktreeB);
    assert.equal(stillRegistered, false, "the child's registry entry must be gone by the time the parent regains control (its own exit cleanup already ran)");
    console.log("[parent] confirmed: the child's registry entry is gone (real process.on('exit') cleanup already ran).");

    // Yet the child's record must already be sitting in the PARENT's own
    // worklog.jsonl — F1's write-time routing, not a live pointer.
    const parentLog = new JsonlWorkLog(parent.resolvedDir);
    const records = parentLog.readAll();
    const childRecord = records.find((record) => record.id === "child-task");
    assert.ok(childRecord, "the child's WorkRecord must be present in the parent's own worklog.jsonl despite the registry pointer being gone");
    assert.equal(childRecord!.role, "subagent");
    assert.equal(childRecord!.parentPid, process.pid, "the child's parentPid must match this real parent process's pid");
    console.log(`[parent] confirmed: the child's record is in ${parent.resolvedDir}/worklog.jsonl, joined by pid/parentPid.`);

    // F5 cross-check: the child's own re-derivation of the parent's start
    // identity (a real ps/proc snapshot, taken independently by the child)
    // must agree with the parent's own uptime-derived value, within
    // tolerance — see `adapters/ancestry.ts#ownStartIdFromUptime`'s doc
    // comment. Both are estimates of the same real event (this parent
    // process's start time) from two entirely different sources.
    const match = /PARENT_LIVE_START_ID_SEEN_BY_CHILD=(-?\d+|undefined)/.exec(result.stdout ?? "");
    assert.ok(match, "the child must have printed its cross-check line");
    assert.notEqual(match![1], "undefined", "the child must have been able to derive the parent's live start id from a real ancestry snapshot");
    const liveStartIdSeenByChild = Number(match![1]);
    const drift = Math.abs(liveStartIdSeenByChild - parent.ownProcessStartId);
    assert.ok(
      drift <= START_ID_TOLERANCE_MS,
      `F5: the child's real ps/proc-derived reading of the parent's start id (${liveStartIdSeenByChild}) must agree with the parent's own uptime-derived value (${parent.ownProcessStartId}) within ${START_ID_TOLERANCE_MS}ms — drift was ${drift}ms`,
    );
    console.log(`[parent] F5 cross-check: own start id ${parent.ownProcessStartId} vs child's real ps/proc reading ${liveStartIdSeenByChild} — drift ${drift}ms, within tolerance.`);

    console.log("[parent] ALL ASSERTIONS PASSED — F1 cross-worktree write routing survives the child's own exit cleanup.");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/**
 * F1: several children writing REALISTICALLY LARGE records into the SAME
 * `worklog.jsonl` concurrently (real, separate OS processes racing each
 * other, launched together — not sequentially via `spawnSync`) must never
 * interleave a partial line into another one. Confirms the module doc
 * comment's atomicity claim (`jsonl-work-log.ts`: "a single `appendFileSync`
 * call so a parent and its subagent children can write concurrently without
 * interleaving lines") against real concurrent processes and real record
 * sizes, not just sequential in-process calls (which a unit test can prove
 * are well-formed, but can never prove are race-free).
 */
function runConcurrentWriter(): void {
  const targetDir = process.env["KANKAKU_E2E_CONCURRENT_DIR"];
  const index = process.env["KANKAKU_E2E_CONCURRENT_INDEX"];
  if (!targetDir || !index) throw new Error("concurrent writer requires KANKAKU_E2E_CONCURRENT_DIR and KANKAKU_E2E_CONCURRENT_INDEX");

  // A realistically large record: a long prompt, a sizeable tools map, and
  // several subagent spans — several KB once serialized, well above a
  // trivial single-line write.
  const tools: Record<string, number> = {};
  for (let i = 0; i < 200; i++) tools[`tool_${i}`] = i;
  const subagents = Array.from({ length: 20 }, (_, i) => ({ toolCallId: `call-${i}`, agent: "reviewer", mode: "task", ms: i * 100 }));

  const log = new JsonlWorkLog(targetDir);
  log.append(
    makeRecord({
      id: `concurrent-writer-${index}`,
      role: "subagent",
      pid: 10_000 + Number(index),
      parentPid: 1,
      project: targetDir,
      prompt: `${index}:${"x".repeat(4000)}`, // a distinctive prefix so cross-contamination would be detectable
      tools,
      subagents,
      startedAt: iso(0),
      settledAt: iso(1000),
    }),
  );
  process.exit(0);
}

async function runConcurrencyStress(): Promise<void> {
  const scratchRoot = process.env["KANKAKU_E2E_SCRATCH"] ?? tmpdir();
  const runDir = mkdtempSync(join(scratchRoot, "kankaku-e2e-concurrency-"));
  const targetDir = join(runDir, ".kankaku");
  mkdirSync(targetDir, { recursive: true });

  try {
    const WRITER_COUNT = 8;
    console.log(`[concurrency] spawning ${WRITER_COUNT} real writer processes concurrently, all targeting ${targetDir}`);

    const children = Array.from({ length: WRITER_COUNT }, (_, i) => {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [THIS_SCRIPT, "--concurrent-writer"], {
          env: { ...process.env, KANKAKU_E2E_CONCURRENT_DIR: targetDir, KANKAKU_E2E_CONCURRENT_INDEX: String(i) },
          stdio: "inherit",
        });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${i} exited with code ${code}`))));
      });
    });

    await Promise.all(children);
    console.log("[concurrency] all writer processes have exited.");

    // Read the RAW file directly (not through JsonlWorkLog.readAll(), which
    // tolerates and silently skips a malformed line) so a corrupted/
    // interleaved write would be caught here as a parse failure, not
    // quietly hidden.
    const raw = readFileSync(join(targetDir, "worklog.jsonl"), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    assert.equal(lines.length, WRITER_COUNT, `expected exactly ${WRITER_COUNT} lines, got ${lines.length} — a lost or split line means the atomic-append claim broke under real concurrency`);

    const seenIndexes = new Set<number>();
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws on any interleaved/corrupted line
      assert.match(parsed.id, /^concurrent-writer-\d+$/);
      const index = Number(parsed.id.replace("concurrent-writer-", ""));
      assert.equal(parsed.prompt.startsWith(`${index}:`), true, `record ${index}'s own prompt prefix must not have been overwritten/mixed by another writer`);
      assert.equal(Object.keys(parsed.tools).length, 200, "the full tools map must be intact, not truncated by an interleaved write");
      assert.equal(parsed.subagents.length, 20, "the full subagents array must be intact");
      seenIndexes.add(index);
    }
    assert.equal(seenIndexes.size, WRITER_COUNT, "every writer's distinct record must be present exactly once");

    console.log(`[concurrency] ALL ${WRITER_COUNT} large concurrent writes landed intact, in ${lines.length} well-formed lines — no interleaving.`);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/**
 * R1 (BLOCKER): a real child process spawned by a parent that was itself
 * started with `KANKAKU_ROLE=orchestrator` (simulating a leaked shell rc/
 * tmux/CI export) must NEVER see that variable — proving `stripRoleOverride`
 * actually removes it from `process.env` before the parent spawns anything,
 * not just that the pure precedence function would handle it correctly in
 * isolation. The child also carries the real confirmed child marker
 * (`GENTLE_PI_AGENTS_CHILD=1`), so it must still classify as `subagent` via
 * its own marker, with nothing left over to contradict it.
 */
function runRoleOverrideChild(): void {
  assert.equal(process.env["KANKAKU_ROLE"], undefined, "a real child process must never inherit its parent's KANKAKU_ROLE override (R1, non-propagation)");

  const { role } = detectRole(process.env, false, true);
  assert.equal(role, "subagent", "GENTLE_PI_AGENTS_CHILD=1 must still classify this real child as subagent, with no leaked override to contradict it");

  console.log("[role-override-child] confirmed: KANKAKU_ROLE was not inherited, and this process still classifies as subagent via its own marker.");
  process.exit(0);
}

/** The "parent" half of the R1 non-propagation proof: a real process started WITH `KANKAKU_ROLE=orchestrator` in its own env. */
function runRoleOverrideParent(): void {
  assert.equal(readRoleOverride(process.env), "orchestrator", "this process must actually have started with KANKAKU_ROLE=orchestrator, or the scenario proves nothing");

  // Mirrors extension.ts's factory-time read-then-strip sequence exactly
  // (R1, layer 2): read it once, then remove it from this process's own
  // env so a child it spawns below never inherits it.
  const { role } = detectRole(process.env, false, true);
  assert.equal(role, "orchestrator", "with no confirmed child marker of its own, this process is a genuine orchestrator despite the leaked override");
  stripRoleOverride(process.env);
  assert.equal(process.env["KANKAKU_ROLE"], undefined, "stripRoleOverride must have removed KANKAKU_ROLE from this process's own env");

  console.log("[role-override-parent] spawning a REAL child with GENTLE_PI_AGENTS_CHILD=1, inheriting this process's (now-stripped) env...");
  const result = spawnSync(process.execPath, [THIS_SCRIPT, "--role-override-child"], {
    env: { ...process.env, GENTLE_PI_AGENTS_CHILD: "1" },
    encoding: "utf8",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.equal(result.status, 0, `the real child must confirm it never saw KANKAKU_ROLE and still classified as subagent (status=${result.status}, error=${result.error})`);

  console.log("[role-override-parent] confirmed: KANKAKU_ROLE stripped from this process's own env before spawning; real child confirmed non-inheritance and correct marker-based classification.");
  process.exit(0);
}

async function runRoleOverrideNonPropagation(): Promise<void> {
  console.log("[role-override] spawning a REAL 'parent' process started with KANKAKU_ROLE=orchestrator (simulating a leaked shell export)...");
  const result = spawnSync(process.execPath, [THIS_SCRIPT, "--role-override-parent"], {
    env: { ...process.env, KANKAKU_ROLE: "orchestrator" },
    encoding: "utf8",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.equal(result.status, 0, `the role-override parent (and its own spawned real child) must both succeed (status=${result.status}, error=${result.error})`);
  console.log("[role-override] ALL ASSERTIONS PASSED — KANKAKU_ROLE never propagates to a real spawned child, whose own marker still decides its role (R1).");
}

/**
 * G1 (HIGH, BLOCKER): a REAL child process that simulates pi re-invoking
 * the extension factory IN THE SAME OS PROCESS (`/new`/`/resume`/`/fork`/
 * `/reload`) by calling `process-identity-memo.ts`'s composition TWICE,
 * exactly mirroring `extension.ts`'s real wiring both times — real
 * `process.env` mutation (the override really is stripped from the real
 * env by the first call), a real `MachineProcessRegistry` writing real
 * files, and a real `process.on("exit", ...)` registration. This is
 * exactly what a unit test (fake env object, fake registry) cannot prove:
 * that the SAME real env object, mutated in place by the first call, does
 * not fool the second call into losing the override, and that a real
 * second `process.on("exit", ...)` call never registers a second listener.
 */
function runDoubleInvocationChild(): void {
  const homeDir = process.env["KANKAKU_E2E_HOME"];
  if (!homeDir) throw new Error("double-invocation child requires KANKAKU_E2E_HOME");
  assert.equal(readRoleOverride(process.env), "orchestrator", "this process must actually start with KANKAKU_ROLE=orchestrator, or the scenario proves nothing");

  const registry = new MachineProcessRegistry(() => homeDir);
  const memo = createProcessIdentityMemo();
  const exitListenersBefore = process.listenerCount("exit");

  function invokeOnceLikeExtensionFactory(cwd: string): ReturnType<typeof memo.resolve> {
    const identity = memo.resolve({
      env: process.env,
      registry,
      ppid: process.ppid,
      now: () => Date.now(),
      uptimeSeconds: () => process.uptime(),
      isInteractiveGuess: false,
    });
    const resolvedDir = resolveKankakuDir(".kankaku", cwd);
    registry.record(
      {
        pid: process.pid,
        parentPid: process.ppid,
        role: identity.role,
        project: cwd,
        dir: resolvedDir,
        startedAt: new Date().toISOString(),
        ...(identity.orchestratorRef !== undefined ? { orchestratorRef: identity.orchestratorRef } : {}),
        processStartId: identity.ownProcessStartId,
      },
      undefined,
      { liveStartId: identity.liveStartId },
    );
    memo.registerExitCleanupOnce(
      (listener) => process.on("exit", listener),
      () => registry.removeOwn?.(process.pid, identity.ownProcessStartId),
    );
    return identity;
  }

  // Invocation 1 — like the very first `/new` of this process.
  const first = invokeOnceLikeExtensionFactory(process.cwd());
  assert.equal(first.roleOverride, "orchestrator");
  assert.equal(process.env["KANKAKU_ROLE"], undefined, "the real env must have been stripped by invocation 1, exactly like a real single-invocation run");

  // Invocation 2 — like pi re-invoking this SAME factory after `/resume`,
  // reading the SAME (now-stripped) real process.env. Before the fix, this
  // would read roleOverride as undefined and could demote role confidence.
  const second = invokeOnceLikeExtensionFactory(process.cwd());
  assert.strictEqual(second, first, "the second invocation must reuse the exact frozen object from the first, never recompute");
  assert.equal(second.roleOverride, "orchestrator", "the override must still be reported on invocation 2, even though process.env no longer carries it");
  assert.equal(second.role, "orchestrator");

  const ownEntries = registry.readAll().filter((entry) => entry.pid === process.pid);
  assert.equal(ownEntries.length, 1, "two invocations of the same process must never produce two registry entries — the filename is keyed by pid");

  const exitListenersAfter = process.listenerCount("exit");
  assert.equal(exitListenersAfter, exitListenersBefore + 1, "two invocations must register the process-wide exit-cleanup listener exactly ONCE, not twice");

  console.log("[double-invocation-child] confirmed: roleOverride survived a second same-process invocation, one registry entry, exactly one exit listener registered.");
  process.exit(0);
}

/** The "parent" half of the G1 double-invocation proof: spawns a real child with `KANKAKU_ROLE=orchestrator` and confirms its registry entry is gone after it exits (proving the single exit listener actually ran). */
async function runDoubleInvocationNonRegression(): Promise<void> {
  const scratchRoot = process.env["KANKAKU_E2E_SCRATCH"] ?? tmpdir();
  const runDir = mkdtempSync(join(scratchRoot, "kankaku-e2e-double-invocation-"));
  const homeDir = join(runDir, "home");
  mkdirSync(homeDir, { recursive: true });

  try {
    console.log("[double-invocation] spawning a REAL process started with KANKAKU_ROLE=orchestrator, simulating two factory invocations in the same process (G1)...");
    const result = spawnSync(process.execPath, [THIS_SCRIPT, "--double-invocation-child"], {
      env: { ...process.env, KANKAKU_ROLE: "orchestrator", KANKAKU_E2E_HOME: homeDir },
      encoding: "utf8",
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    assert.equal(result.status, 0, `the double-invocation child must confirm every G1 assertion (status=${result.status}, error=${result.error})`);

    const runDirEntries = join(homeDir, ".kankaku", "run");
    const remaining = existsSync(runDirEntries) ? readdirSync(runDirEntries) : [];
    assert.equal(remaining.length, 0, "the single registered exit listener must have removed the process's own registry entry on real exit");

    console.log("[double-invocation] ALL ASSERTIONS PASSED — a role override survives a same-process factory re-invocation, with no duplicate registry entry or exit-listener leak (G1).");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

const mode = process.argv.includes("--child")
  ? "child"
  : process.argv.includes("--concurrent-writer")
    ? "concurrent-writer"
    : process.argv.includes("--role-override-parent")
      ? "role-override-parent"
      : process.argv.includes("--role-override-child")
        ? "role-override-child"
        : process.argv.includes("--double-invocation-child")
          ? "double-invocation-child"
          : "parent";

if (mode === "child") {
  runChild();
} else if (mode === "concurrent-writer") {
  runConcurrentWriter();
} else if (mode === "role-override-parent") {
  runRoleOverrideParent();
} else if (mode === "role-override-child") {
  runRoleOverrideChild();
} else if (mode === "double-invocation-child") {
  runDoubleInvocationChild();
} else {
  (async () => {
    await runParent();
    await runConcurrencyStress();
    await runRoleOverrideNonPropagation();
    await runDoubleInvocationNonRegression();
  })().catch((error) => {
    console.error("REAL-PROCESS E2E FAILED:", error);
    process.exitCode = 1;
  });
}
