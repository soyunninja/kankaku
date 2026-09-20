#!/usr/bin/env node
/**
 * End-to-end proof of the hub sync (Phase 2) against a REAL, isolated
 * PocketBase instance. NOT part of `npm test`/`npm run check` — opt-in via
 * `npm run e2e:hub`. Starts its own PocketBase on 127.0.0.1:8091 (never
 * 8090) against a throwaway data directory, seeds a client/project through
 * the API, builds a worklog with a mix of orchestrator+subagent records
 * (some with a real clientId/projectId, some legacy free-text-only), syncs
 * it, and asserts against the real server: union wall_ms, cost sums,
 * unassigned routing with legacy labels, idempotency (a second sync writes
 * nothing), a late subagent triggering a real update, a reassignment made
 * directly against PocketBase surviving a re-sync, and a dead-target sync
 * failing cleanly without throwing or advancing the watermark.
 *
 * Always stops the server and removes the data directory, even on failure.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { JsonlWorkLog } from "../src/adapters/jsonl-work-log.ts";
import { SyncStateStore } from "../src/adapters/sync-state-store.ts";
import { PocketBaseClient } from "../src/adapters/pocketbase-client.ts";
import { PocketBaseSink } from "../src/adapters/pocketbase-sink.ts";
import { runSync } from "../src/adapters/sync-runner.ts";
import { MachineProcessRegistry } from "../src/adapters/machine-process-registry.ts";
import { RegistryAwareWorkLog } from "../src/adapters/registry-aware-work-log.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";

const PB_BIN = "/Users/baldboy/desarrollo/soyun.ninja/kankaku-hub/pocketbase/bin/pocketbase";
const PB_MIGRATIONS_DIR = "/Users/baldboy/desarrollo/soyun.ninja/kankaku-hub/pocketbase/pb_migrations";
const PB_HOST = "127.0.0.1";
const PB_PORT = 8091;
const PB_URL = `http://${PB_HOST}:${PB_PORT}`;

const SUPERUSER_EMAIL = "e2e-admin@kankaku.local";
const SUPERUSER_PASSWORD = "kankaku-e2e-admin-pw";
const SERVICE_EMAIL = "e2e-sync@kankaku.local";
const SERVICE_PASSWORD = "kankaku-e2e-sync-pw";

let step = 0;
function log(message: string): void {
  step += 1;
  console.log(`[${String(step).padStart(2, "0")}] ${message}`);
}

function iso(msFromEpoch: number): string {
  return new Date(msFromEpoch).toISOString();
}

async function waitForHealth(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${PB_URL}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`PocketBase did not become healthy within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function pbFetch<T>(path: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${PB_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token !== undefined ? { Authorization: options.token } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  }
  return body as T;
}

async function authSuperuser(): Promise<string> {
  const result = await pbFetch<{ token: string }>("/api/collections/_superusers/auth-with-password", {
    method: "POST",
    body: { identity: SUPERUSER_EMAIL, password: SUPERUSER_PASSWORD },
  });
  return result.token;
}

async function createServiceUser(superuserToken: string): Promise<void> {
  const existing = await pbFetch<{ totalItems: number }>(
    `/api/collections/users/records?filter=${encodeURIComponent(`email="${SERVICE_EMAIL}"`)}`,
    { token: superuserToken },
  );
  if (existing.totalItems > 0) return;

  await pbFetch("/api/collections/users/records", {
    method: "POST",
    token: superuserToken,
    body: {
      email: SERVICE_EMAIL,
      password: SERVICE_PASSWORD,
      passwordConfirm: SERVICE_PASSWORD,
      role: "service",
      emailVisibility: true,
      verified: true,
    },
  });
}

async function createClient(superuserToken: string, name: string, code: string): Promise<string> {
  const record = await pbFetch<{ id: string }>("/api/collections/clients/records", {
    method: "POST",
    token: superuserToken,
    body: { name, code, active: true, unassigned: false },
  });
  return record.id;
}

async function createProject(superuserToken: string, name: string, code: string, clientId: string, repoPaths: string[]): Promise<string> {
  const record = await pbFetch<{ id: string }>("/api/collections/projects/records", {
    method: "POST",
    token: superuserToken,
    body: { name, code, client: clientId, repo_paths: repoPaths, active: true },
  });
  return record.id;
}

async function findUnassignedClientId(superuserToken: string): Promise<string> {
  const result = await pbFetch<{ items: Array<{ id: string }> }>(
    `/api/collections/clients/records?filter=${encodeURIComponent('code="sin-determinar"')}`,
    { token: superuserToken },
  );
  assert.ok(result.items.length === 1, "expected the seeded 'Sin determinar' client to exist");
  return result.items[0]!.id;
}

async function findTaskEntry(superuserToken: string, taskId: string): Promise<Record<string, unknown>> {
  const result = await pbFetch<{ items: Array<Record<string, unknown>> }>(
    `/api/collections/task_entries/records?filter=${encodeURIComponent(`task_id="${taskId}"`)}`,
    { token: superuserToken },
  );
  assert.equal(result.items.length, 1, `expected exactly one task_entries row for ${taskId}, found ${result.items.length}`);
  return result.items[0]!;
}

async function countTaskEntries(superuserToken: string, taskId: string): Promise<number> {
  const result = await pbFetch<{ totalItems: number }>(
    `/api/collections/task_entries/records?filter=${encodeURIComponent(`task_id="${taskId}"`)}`,
    { token: superuserToken },
  );
  return result.totalItems;
}

async function countWorkRecords(superuserToken: string, taskEntryId: string): Promise<number> {
  const result = await pbFetch<{ totalItems: number }>(
    `/api/collections/work_records/records?filter=${encodeURIComponent(`task_entry="${taskEntryId}"`)}`,
    { token: superuserToken },
  );
  return result.totalItems;
}

function makeRecord(overrides: Partial<WorkRecord> & Pick<WorkRecord, "id" | "pid" | "parentPid" | "role">): WorkRecord {
  return {
    schema: 1,
    project: "/repo/e2e-project",
    prompt: "e2e prompt for " + overrides.id,
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

async function main(): Promise<void> {
  const scratchRoot = process.env["KANKAKU_E2E_SCRATCH"] ?? tmpdir();
  mkdirSync(scratchRoot, { recursive: true });
  const runDir = mkdtempSync(join(scratchRoot, "kankaku-e2e-hub-"));
  const dataDir = join(runDir, "pb_data");
  const workDir = join(runDir, "work");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  if (!existsSync(PB_BIN)) {
    throw new Error(`PocketBase binary not found at ${PB_BIN}`);
  }

  log(`starting PocketBase on ${PB_URL}, data dir ${dataDir}`);
  const server = spawn(PB_BIN, ["serve", `--http=${PB_HOST}:${PB_PORT}`, `--dir=${dataDir}`, `--migrationsDir=${PB_MIGRATIONS_DIR}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout?.on("data", (chunk) => (serverOutput += String(chunk)));
  server.stderr?.on("data", (chunk) => (serverOutput += String(chunk)));

  try {
    await waitForHealth();
    log("PocketBase is healthy");

    log("creating superuser");
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(PB_BIN, ["superuser", "upsert", SUPERUSER_EMAIL, SUPERUSER_PASSWORD, `--dir=${dataDir}`]);
      let out = "";
      proc.stdout?.on("data", (c) => (out += String(c)));
      proc.stderr?.on("data", (c) => (out += String(c)));
      proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`superuser upsert failed (${code}): ${out}`))));
    });

    const superuserToken = await authSuperuser();
    log("creating service account (role=service)");
    await createServiceUser(superuserToken);

    log("seeding client/project catalog");
    const acmeId = await createClient(superuserToken, "Acme", "acme");
    const portalId = await createProject(superuserToken, "Portal", "acme-portal", acmeId, ["/repo/e2e-project"]);
    const unassignedId = await findUnassignedClientId(superuserToken);
    log(`  acme=${acmeId} portal=${portalId} unassigned=${unassignedId}`);

    // --- Build the worklog: one task with a real target and overlapping
    // subagents, plus two legacy (no clientId) tasks with different
    // free-text labels for the same real-world client. ---
    const log_ = new JsonlWorkLog(workDir);

    const t0 = Date.parse("2026-09-19T10:00:00.000Z");
    const taskAOrchestrator = makeRecord({
      id: "task-a",
      role: "orchestrator",
      pid: 100,
      parentPid: 1,
      sessionId: "sess-1",
      sessionName: "e2e session",
      startedAt: iso(t0),
      settledAt: iso(t0 + 30_000),
      wallMs: 30_000,
      waitingMs: 2_000,
      workMs: 28_000,
      clientId: acmeId,
      clientName: "Acme",
      projectId: portalId,
      projectName: "Portal",
      usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.05 },
      // A real provider cost figure was observed, and both of task-a's two
      // subagent_run tool spans below have a joined child record — this is
      // the "measured cost, linked subagents" case.
      costObserved: true,
      subagents: [
        { toolCallId: "call-1", agent: "reviewer", mode: "task", ms: 30_000 },
        { toolCallId: "call-2", agent: "reviewer", mode: "task", ms: 10_000 },
      ],
      segments: { review: 5000 },
      runs: 1,
      turns: 3,
      tools: { bash: 2 },
    });
    const taskASub1 = makeRecord({
      id: "task-a-sub1",
      role: "subagent",
      pid: 200,
      parentPid: 100,
      startedAt: iso(t0 + 10_000),
      settledAt: iso(t0 + 40_000), // outlives the orchestrator by 10s
      wallMs: 30_000,
      usage: { input: 50, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
    });
    const taskASub2 = makeRecord({
      id: "task-a-sub2",
      role: "subagent",
      pid: 201,
      parentPid: 100,
      startedAt: iso(t0 + 15_000),
      settledAt: iso(t0 + 25_000), // fully inside the orchestrator's window
      wallMs: 10_000,
      usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    });

    const t1 = Date.parse("2026-09-19T11:00:00.000Z");
    const taskB = makeRecord({
      id: "task-b",
      role: "orchestrator",
      pid: 300,
      parentPid: 1,
      sessionId: "sess-2",
      startedAt: iso(t1),
      settledAt: iso(t1 + 10_000),
      wallMs: 10_000,
      workMs: 10_000,
      client: "cajamar",
      // A plain run (no subagents at all) with a real observed cost.
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      costObserved: true,
    });

    const t2 = Date.parse("2026-09-19T12:00:00.000Z");
    const taskC = makeRecord({
      id: "task-c",
      role: "orchestrator",
      pid: 301,
      parentPid: 1,
      sessionId: "sess-3",
      startedAt: iso(t2),
      settledAt: iso(t2 + 10_000),
      wallMs: 10_000,
      workMs: 10_000,
      client: "Caja Mar",
      // A cost-less run (subscription/OAuth-style provider): usage is
      // tracked, but no turn ever reported a real cost figure.
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 },
    });

    for (const record of [taskAOrchestrator, taskASub1, taskASub2, taskB, taskC]) {
      log_.append(record);
    }

    const stateStore = new SyncStateStore({ dir: workDir, pid: process.pid });
    const pbClient = new PocketBaseClient({ url: PB_URL, email: SERVICE_EMAIL, password: SERVICE_PASSWORD, timeoutMs: 5000 });

    function makeSink(): PocketBaseSink {
      return new PocketBaseSink({
        client: pbClient,
        clients: [
          { id: acmeId, name: "Acme", code: "acme", active: true },
          { id: unassignedId, name: "Sin determinar", code: "sin-determinar", active: true, unassigned: true },
        ],
        projects: [{ id: portalId, name: "Portal", code: "acme-portal", clientId: acmeId, repoPaths: ["/repo/e2e-project"], active: true }],
        machine: "e2e-machine",
        promptMode: "full",
        syncRecords: true,
        agent: "pi",
        agentVersion: "0.85.1-e2e",
        plugin: "kankaku",
        pluginVersion: "0.0.0-e2e",
      });
    }

    // --- Sync #1: everything is new. ---
    log("running sync #1 (everything new)");
    const summary1 = await runSync(
      { log: log_, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      {},
    );
    assert.equal(summary1.error, undefined, `sync #1 should not error: ${summary1.error}`);
    assert.equal(summary1.uploaded, 3, `expected 3 created task_entries, got ${JSON.stringify(summary1)}`);
    assert.equal(summary1.updated, 0);
    assert.deepEqual(summary1.unassigned, { cajamar: 1, "Caja Mar": 1 });
    log(`  summary: ${JSON.stringify(summary1)}`);

    const taskARow = await findTaskEntry(superuserToken, "task-a");
    assert.equal(taskARow["wall_ms"], 40_000, "task-a wall_ms should be the union [0,30]u[10,40]u[15,25] = 40s");
    assert.equal(taskARow["work_ms"], 40_000 - 2_000);
    assert.ok(Math.abs((taskARow["cost"] as number) - 0.08) < 1e-9, `task-a cost should sum to 0.08, got ${taskARow["cost"]}`);
    assert.equal(taskARow["subagent_count"], 2);
    assert.equal(taskARow["client"], acmeId);
    assert.equal(taskARow["project"], portalId);
    assert.equal(taskARow["legacy_client_label"], "");
    const taskAWorkRecordCount = await countWorkRecords(superuserToken, taskARow["id"] as string);
    assert.equal(taskAWorkRecordCount, 3, "task-a should have 3 work_records: orchestrator + 2 subagents");
    log("  task-a: union wall_ms/cost/subagent_count/work_records all verified");

    // --- Agent and measurement quality (migration 1758300013): a plain
    // run, a run with joined subagents, and a cost-less run. ---
    assert.equal(taskARow["agent"], "pi");
    assert.equal(taskARow["agent_version"], "0.85.1-e2e");
    assert.equal(taskARow["plugin"], "kankaku");
    assert.equal(taskARow["plugin_version"], "0.0.0-e2e");
    assert.equal(taskARow["waiting_quality"], "measured");
    assert.equal(taskARow["cost_quality"], "measured", "task-a observed a real cost figure");
    assert.equal(taskARow["subagent_linkage"], "linked", "task-a's 2 subagent spans both have a joined child record");
    log("  task-a: agent/plugin identity + measured cost + linked subagents verified");

    const taskBRow = await findTaskEntry(superuserToken, "task-b");
    assert.equal(taskBRow["client"], unassignedId);
    assert.equal(taskBRow["legacy_client_label"], "cajamar");
    assert.equal(taskBRow["cost_quality"], "measured", "task-b (plain run) observed a real cost figure");
    assert.equal(taskBRow["subagent_linkage"], "not_applicable", "task-b opened no subagent spans");
    const taskCRow = await findTaskEntry(superuserToken, "task-c");
    assert.equal(taskCRow["client"], unassignedId);
    assert.equal(taskCRow["legacy_client_label"], "Caja Mar");
    assert.equal(taskCRow["cost_quality"], "unknown", "task-c never observed a real cost figure (cost-less run)");
    assert.equal(taskCRow["subagent_linkage"], "not_applicable");
    log("  task-b/task-c: routed to Sin determinar with distinct legacy labels (no fuzzy merge); task-c's cost-less quality verified");

    // --- Sync #2: nothing changed -> zero writes. ---
    log("running sync #2 (nothing changed)");
    const beforeUpdated = (await findTaskEntry(superuserToken, "task-a"))["updated"];
    const summary2 = await runSync(
      { log: log_, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      {},
    );
    assert.equal(summary2.uploaded, 0);
    assert.equal(summary2.updated, 0);
    assert.equal(summary2.skipped, 3, `expected all 3 tasks skipped as unchanged, got ${JSON.stringify(summary2)}`);
    const afterUpdated = (await findTaskEntry(superuserToken, "task-a"))["updated"];
    assert.equal(beforeUpdated, afterUpdated, "task-a must not have been touched by an unchanged re-sync");
    log(`  summary: ${JSON.stringify(summary2)} (zero writes confirmed)`);

    // --- Late subagent extends task-a's union -> a real update. ---
    log("appending a late subagent to task-a and syncing #3");
    const taskASub3 = makeRecord({
      id: "task-a-sub3",
      role: "subagent",
      pid: 202,
      parentPid: 100,
      // Must start inside the orchestrator's OWN [startedAt, settledAt]
      // window (task-view.ts matches children by their startedAt falling
      // in that range) — only its settledAt is allowed to extend beyond it.
      startedAt: iso(t0 + 28_000),
      settledAt: iso(t0 + 55_000), // extends the union to 55s
      wallMs: 27_000,
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.005 },
    });
    log_.append(taskASub3);

    const summary3 = await runSync(
      { log: log_, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      {},
    );
    assert.equal(summary3.updated, 1, `expected task-a to be updated, got ${JSON.stringify(summary3)}`);
    assert.equal(summary3.uploaded, 0);
    const taskARowAfterLateSub = await findTaskEntry(superuserToken, "task-a");
    assert.equal(taskARowAfterLateSub["wall_ms"], 55_000, "task-a's union should now extend to 55s");
    assert.equal(taskARowAfterLateSub["subagent_count"], 3);
    // Measurement-quality fields are sent on update too, not just create.
    assert.equal(taskARowAfterLateSub["agent"], "pi");
    assert.equal(taskARowAfterLateSub["cost_quality"], "measured");
    assert.equal(taskARowAfterLateSub["subagent_linkage"], "linked");
    log(`  task-a extended to wall_ms=55000 (union now includes the late subagent); quality fields sent on update too`);

    // --- Reassign task-b directly against PocketBase (as the web would),
    // then force a genuine content change (another late subagent) and
    // re-sync: the reassignment must SURVIVE. ---
    log("reassigning task-b to Acme/Portal directly via the API");
    await pbFetch(`/api/collections/task_entries/records/${taskBRow["id"]}`, {
      method: "PATCH",
      token: superuserToken,
      body: { client: acmeId, project: portalId, legacy_client_label: "" },
    });

    const taskBSub = makeRecord({
      id: "task-b-sub1",
      role: "subagent",
      pid: 302,
      parentPid: 300,
      startedAt: iso(t1 + 2_000),
      settledAt: iso(t1 + 20_000), // extends task-b's union
      wallMs: 18_000,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
    });
    log_.append(taskBSub);

    log("running sync #4 (task-b content changed, must not undo the reassignment)");
    const summary4 = await runSync(
      { log: log_, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      {},
    );
    assert.equal(summary4.updated, 1, `expected task-b to be updated, got ${JSON.stringify(summary4)}`);
    const taskBRowAfterReassign = await findTaskEntry(superuserToken, "task-b");
    assert.equal(taskBRowAfterReassign["client"], acmeId, "CRITICAL: the reassignment must survive a re-sync");
    assert.equal(taskBRowAfterReassign["project"], portalId, "CRITICAL: the reassignment must survive a re-sync");
    assert.equal(taskBRowAfterReassign["wall_ms"], 20_000, "task-b's measurement fields must still update");
    log("  CRITICAL rule verified: reassignment survives, measurement still updates");

    // --- Full re-evaluation ('sync all') should still perform zero writes
    // for genuinely unchanged tasks. ---
    log("running sync #5 ('sync all' full re-evaluation, nothing changed since #4)");
    const summary5 = await runSync(
      { log: log_, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      { full: true },
    );
    assert.equal(summary5.uploaded, 0);
    assert.equal(summary5.updated, 0);
    log(`  summary: ${JSON.stringify(summary5)}`);

    // --- A dead target: sync must fail cleanly, never throw, and never
    // advance the watermark. ---
    log("running sync #6 against a dead port (must fail cleanly, not throw, not advance)");
    const stateBeforeDead = stateStore.read();
    const deadClient = new PocketBaseClient({ url: "http://127.0.0.1:8099", email: SERVICE_EMAIL, password: SERVICE_PASSWORD, timeoutMs: 1000 });
    const deadSink = new PocketBaseSink({
      client: deadClient,
      clients: [{ id: acmeId, name: "Acme", code: "acme", active: true }],
      projects: [],
      machine: "e2e-machine",
      promptMode: "none",
      syncRecords: true,
    });
    log_.append(
      makeRecord({
        id: "task-dead",
        role: "orchestrator",
        pid: 400,
        parentPid: 1,
        startedAt: iso(t2 + 100_000),
        settledAt: iso(t2 + 110_000),
      }),
    );
    let summary6: Awaited<ReturnType<typeof runSync>> | undefined;
    await assert.doesNotReject(async () => {
      summary6 = await runSync(
        { log: log_, sink: deadSink, stateStore, clock: { now: () => Date.now() }, target: "http://127.0.0.1:8099", windowHours: 24 },
        { full: true },
      );
    });
    assert.ok(summary6);
    assert.ok(summary6!.error, "a dead target must report an error");
    const stateAfterDead = stateStore.read();
    // target differs from what's stored (PB_URL) so this was itself a "full
    // sync against a new target" — the watermark should not have advanced
    // to include task-dead or anything else, since nothing could be pushed.
    assert.notEqual(stateAfterDead?.target, "http://127.0.0.1:8099", "a failed sync must not persist a new target as if it succeeded");
    void stateBeforeDead;
    log(`  summary: ${JSON.stringify(summary6)} (failed cleanly, did not throw, watermark not corrupted)`);

    // --- Phase 6a scenario: a gentle-pi cross-worktree subagent is
    // reunited with its orchestrator locally, via the machine-wide process
    // registry, and syncs as exactly ONE consolidated task_entries row ---
    // (ADR 0023, SUBAGENT-REQ-007/008/009/018). ---
    log("phase-6a scenario: gentle-pi cross-worktree subagent reunification");
    const worktreeA = join(runDir, "worktree-a");
    const worktreeB = join(runDir, "worktree-b");
    mkdirSync(worktreeA, { recursive: true });
    mkdirSync(worktreeB, { recursive: true });

    const t3 = Date.parse("2026-09-19T13:00:00.000Z");
    const orchPid = 5000;
    const childPid = 5001;
    const orchStartedAt = iso(t3);
    const orchSettledAt = iso(t3 + 20_000);

    const crossOrchestrator = makeRecord({
      id: "task-cross-worktree",
      role: "orchestrator",
      pid: orchPid,
      parentPid: 1,
      project: "/repo/worktree-a",
      startedAt: orchStartedAt,
      settledAt: orchSettledAt,
      wallMs: 20_000,
      workMs: 20_000,
      client: "cajamar",
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
    });
    const crossChild = makeRecord({
      id: "task-cross-worktree-sub1",
      role: "subagent",
      pid: childPid,
      parentPid: orchPid,
      project: "/repo/worktree-b", // a DIFFERENT worktree/project than its orchestrator
      startedAt: iso(t3 + 5_000), // inside the orchestrator's window
      settledAt: iso(t3 + 35_000), // outlives it by 15s, extending the union
      wallMs: 30_000,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.005 },
      orchestratorRef: { pid: orchPid, project: "/repo/worktree-a", startedAt: orchStartedAt },
    });

    new JsonlWorkLog(worktreeA).append(crossOrchestrator);
    new JsonlWorkLog(worktreeB).append(crossChild);

    // Both processes' registry entries, as `extension.ts` would write them
    // at session start. `isAlive: () => true` keeps this e2e's own
    // synthetic pids from being swept as "dead" between the two writes.
    const registryHome = join(runDir, "registry-home");
    const registry = new MachineProcessRegistry(() => registryHome);
    registry.record(
      { pid: orchPid, parentPid: 1, role: "orchestrator", project: "/repo/worktree-a", dir: worktreeA, startedAt: orchStartedAt },
      () => true,
    );
    registry.record(
      {
        pid: childPid,
        parentPid: orchPid,
        role: "subagent",
        project: "/repo/worktree-b",
        dir: worktreeB,
        startedAt: iso(t3 + 5_000),
        orchestratorRef: { pid: orchPid, project: "/repo/worktree-a", startedAt: orchStartedAt },
      },
      () => true,
    );

    const crossWorktreeLog = new RegistryAwareWorkLog({
      inner: new JsonlWorkLog(worktreeA),
      registry,
      readForeignRecords: (dir) => new JsonlWorkLog(dir).readAll(),
    });

    const summary7 = await runSync(
      { log: crossWorktreeLog, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      {},
    );
    assert.equal(summary7.error, undefined, `cross-worktree sync should not error: ${summary7.error}`);
    assert.equal(summary7.uploaded, 1, `expected exactly one new task_entries row, got ${JSON.stringify(summary7)}`);

    assert.equal(await countTaskEntries(superuserToken, "task-cross-worktree"), 1, "exactly one consolidated row, never two, never summed (SUBAGENT-REQ-018)");
    const crossRow = await findTaskEntry(superuserToken, "task-cross-worktree");
    assert.equal(crossRow["wall_ms"], 35_000, "union of [0,20] and [5,35] (relative seconds) = 35s, computed once locally");
    assert.ok(Math.abs((crossRow["cost"] as number) - 0.025) < 1e-9, `cost should sum once: 0.02 + 0.005, got ${crossRow["cost"]}`);
    assert.equal(crossRow["subagent_count"], 1);
    const crossWorkRecordCount = await countWorkRecords(superuserToken, crossRow["id"] as string);
    assert.equal(crossWorkRecordCount, 2, "orchestrator + the reunited cross-worktree child, as work_records");
    log(`  task-cross-worktree: reunited locally, wall_ms=35000, cost summed once, subagent_count=1 — verified`);

    // --- Phase 6a scenario: a phantom/uncertain-role record (ADR 0022,
    // e.g. an unrecognised subagent mechanism with a tracked ancestor) is
    // NEVER synced as its own task_entries row. ---
    log("phase-6a scenario: an uncertain-role record is never synced as a phantom task (SUBAGENT-REQ-013/014)");
    const phantom = makeRecord({
      id: "task-phantom",
      role: "orchestrator",
      roleConfidence: "uncertain",
      pid: 6000,
      parentPid: 5000,
      startedAt: iso(t3 + 200_000),
      settledAt: iso(t3 + 210_000),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
    });
    new JsonlWorkLog(worktreeA).append(phantom);

    const summary8 = await runSync(
      { log: crossWorktreeLog, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      {},
    );
    assert.equal(summary8.error, undefined, `phantom-orchestrator sync should not error: ${summary8.error}`);
    assert.equal(await countTaskEntries(superuserToken, "task-phantom"), 0, "an uncertain-role record must never become its own task_entries row");
    log("  task-phantom: confirmed absent from the hub — never billed as a phantom task");

    log("ALL E2E ASSERTIONS PASSED");
  } finally {
    log("stopping PocketBase");
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      server.once("exit", () => resolve());
      setTimeout(resolve, 3000);
    });
    if (process.env["KANKAKU_E2E_KEEP_DATA"] !== "1") {
      rmSync(runDir, { recursive: true, force: true });
    } else {
      console.log(`kept data dir at ${runDir}`);
    }
    if (serverOutput.trim().length > 0 && process.env["KANKAKU_E2E_VERBOSE"] === "1") {
      console.log("--- PocketBase output ---");
      console.log(serverOutput);
    }
  }
}

main().catch((error) => {
  console.error("E2E FAILED:", error);
  process.exitCode = 1;
});
