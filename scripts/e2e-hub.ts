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
 * directly against PocketBase surviving a re-sync, a dead-target sync
 * failing cleanly without throwing or advancing the watermark, and F1's
 * cross-worktree write-routing surviving the child's own exit cleanup
 * across two sync passes without ever shrinking the row.
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

    // --- F1 scenario: a gentle-pi cross-worktree subagent's work log is
    // routed, at WRITE time, straight into its orchestrator's own kankaku
    // directory (F1's rewrite of ADR 0023 — the old read-time
    // `RegistryAwareWorkLog` merge is gone). This reproduces the real
    // ordering the review proved for gentle-pi's main case (a blocking
    // `subagent_run` in task mode): the child registers, resolves its
    // orchestrator's dir via the registry, writes its OWN record straight
    // into THAT directory, then removes its own registry entry on exit
    // (`process.on("exit")`/`session_shutdown`) — and only THEN does the
    // parent sync, more than once. Because the record already lives in the
    // parent's `worklog.jsonl`, the pointer disappearing changes nothing:
    // the row must be complete on the first sync AND must never shrink on a
    // later one (ADR 0023, SUBAGENT-REQ-007/008/009/018). ---
    log("F1 scenario: cross-worktree subagent write-routing survives the child's own exit cleanup");
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
    // `project` still records the child's OWN cwd (worktree-b) — that never
    // changes — but its record is appended to worktree-A's log, exactly as
    // `extension.ts`'s F1 write-routing would: `orchestratorRef.dir` names
    // the orchestrator's directory, and a verified subagent writes there
    // instead of its own cwd-relative one.
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
      orchestratorRef: { pid: orchPid, project: "/repo/worktree-a", startedAt: orchStartedAt, dir: worktreeA },
    });

    const worktreeALog = new JsonlWorkLog(worktreeA);
    worktreeALog.append(crossOrchestrator);
    // F1: the child writes into the ORCHESTRATOR's directory, not its own
    // (worktree-B's log is never even created here — nothing should ever
    // need to read it).
    worktreeALog.append(crossChild);

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
        orchestratorRef: { pid: orchPid, project: "/repo/worktree-a", startedAt: orchStartedAt, dir: worktreeA },
      },
      () => true,
    );

    // The child exits: its own registry entry is removed (mirrors
    // `extension.ts`'s `process.on("exit")`/`session_shutdown` cleanup) —
    // BEFORE the parent ever syncs. No later reader needs this pointer at
    // all any more; this only proves that its absence changes nothing.
    registry.removeOwn(childPid, undefined);
    assert.equal(
      registry.readAll().some((entry) => entry.pid === childPid),
      false,
      "the child's registry entry must actually be gone before the parent syncs",
    );

    // The parent syncs from a PLAIN JsonlWorkLog on its own directory — no
    // registry-aware wrapper of any kind is involved any more.
    const summary7 = await runSync(
      { log: worktreeALog, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
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
    log(`  task-cross-worktree: reunited by write routing, wall_ms=35000, cost summed once, subagent_count=1 — verified`);

    // --- F1 regression: a SECOND sync pass, run after the child's registry
    // entry is already gone, must produce IDENTICAL numbers — never a
    // shrink. `buildTaskEntryUpdatePayload` recomputes wall_ms/cost/
    // subagent_count/subagent_linkage straight from the current TaskView on
    // every pass; if the child were ever rediscovered only through a live
    // registry pointer (the old design), this second pass — with that
    // pointer gone — would silently recompute a SMALLER union and erase
    // already-uploaded work. It must not, because the record was never
    // anywhere else to begin with. ---
    log("F1 regression: a second sync pass after the child's registry entry is gone must not shrink the row");
    const summary7b = await runSync(
      { log: worktreeALog, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      { full: true },
    );
    assert.equal(summary7b.error, undefined, `second cross-worktree sync pass should not error: ${summary7b.error}`);
    const crossRowAfterSecondSync = await findTaskEntry(superuserToken, "task-cross-worktree");
    assert.equal(crossRowAfterSecondSync["wall_ms"], 35_000, "wall_ms must NEVER shrink on a later sync pass");
    assert.ok(Math.abs((crossRowAfterSecondSync["cost"] as number) - 0.025) < 1e-9, "cost must NEVER shrink on a later sync pass");
    assert.equal(crossRowAfterSecondSync["subagent_count"], 1, "subagent_count must NEVER shrink on a later sync pass");
    assert.equal(await countTaskEntries(superuserToken, "task-cross-worktree"), 1, "still exactly one row, never split into two by the second pass");
    log("  second sync pass: wall_ms/cost/subagent_count all unchanged — the hub row never shrank");

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
    worktreeALog.append(phantom);

    const summary8 = await runSync(
      { log: worktreeALog, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      {},
    );
    assert.equal(summary8.error, undefined, `phantom-orchestrator sync should not error: ${summary8.error}`);
    assert.equal(await countTaskEntries(superuserToken, "task-phantom"), 0, "an uncertain-role record must never become its own task_entries row");
    log("  task-phantom: confirmed absent from the hub — never billed as a phantom task");

    // --- Phase 6b scenario: a configured third-party subagent tool
    // (KANKAKU_SUBAGENT_TOOLS/KANKAKU_SUBAGENT_CHILD_ENV, no separate
    // OS-process child of its own in this scenario — the child never runs
    // kankaku, so there is no separately-joined WorkRecord for it) whose
    // tool result forwarded `usage` (SUBAGENT-REQ-006, revised by C1). The
    // forwarded usage/cost lives on the span as `forwardedUsage` (never
    // folded into the orchestrator's own `usage` at write time any more —
    // see domain/work-tracker.ts#onToolEnd); `domain/task-view.ts#buildTasks`
    // adds it to the task total because no same-profile child was ever
    // joined here. This proves the sync pipeline carries that reconciled
    // total through to the hub row's cost/input/output, counted once, with
    // subagent_linkage correctly reported "unlinked" (a span was opened,
    // but no child record ever joined it — the same conservative bucket a
    // genuine in-process mechanism would fall into, see
    // domain/hub-entry.ts#computeSubagentLinkage). ---
    log("phase-6b/6c scenario: a configured subagent tool's forwarded usage reaches the hub row, counted once, subagent_linkage=unlinked");
    const t4 = Date.parse("2026-09-19T14:00:00.000Z");
    const configuredToolTask = makeRecord({
      id: "task-configured-tool",
      role: "orchestrator",
      pid: 7000,
      parentPid: 1,
      startedAt: iso(t4),
      settledAt: iso(t4 + 20_000),
      wallMs: 20_000,
      waitingMs: 0,
      workMs: 20_000,
      // Only the orchestrator's own real turn usage — the configured
      // tool's forwarded usage lives on the span below, not here (C1).
      usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      costObserved: true,
      runs: 1,
      turns: 1,
      tools: { my_review_tool: 1 },
      subagents: [
        {
          toolCallId: "call-configured-1",
          agent: "reviewer",
          mode: "task",
          ms: 5_000,
          profile: "configured",
          forwardedUsage: { input: 25, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.004 },
        },
      ],
    });
    worktreeALog.append(configuredToolTask);

    const summary9 = await runSync(
      { log: worktreeALog, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      {},
    );
    assert.equal(summary9.error, undefined, `configured-tool sync should not error: ${summary9.error}`);
    const configuredRow = await findTaskEntry(superuserToken, "task-configured-tool");
    assert.equal(configuredRow["input"], 125);
    assert.equal(configuredRow["output"], 50);
    assert.ok(Math.abs((configuredRow["cost"] as number) - 0.014) < 1e-9, "forwarded usage cost must be counted exactly once — no joined same-profile child here, so buildTasks adds it");
    assert.equal(configuredRow["cost_quality"], "measured");
    assert.equal(configuredRow["subagent_count"], 0, "no child record was ever joined for this span");
    assert.equal(configuredRow["subagent_linkage"], "unlinked", "a span was opened but never joined — the conservative bucket, never guessed 'linked'");
    assert.equal(await countWorkRecords(superuserToken, configuredRow["id"] as string), 1, "exactly one work_records row — the orchestrator's own, nothing duplicated");
    log("  task-configured-tool: forwarded usage counted once, subagent_linkage=unlinked — verified");

    // --- C1 (CRITICAL fix) scenario A: an ambiguous "subagent" tool call
    // (2+ profiles register the same name — e.g. pi-reference and
    // pi-subagents, both always active) must never forward usage/taskId
    // from any candidate. This is already guaranteed at the unit level
    // (tests/work-tracker.test.ts), but proves it end to end through the
    // real sync pipeline: the span carries NO `profile` and NO
    // `forwardedUsage` (exactly what WorkTracker now produces for an
    // ambiguous match), so the hub row's cost must be EXACTLY the
    // orchestrator's own directly-observed turn usage, unaffected. ---
    log("C1 scenario A: an ambiguous subagent call carrying usage never inflates the hub row's cost");
    const t5 = Date.parse("2026-09-19T15:00:00.000Z");
    const ambiguousTask = makeRecord({
      id: "task-ambiguous-subagent",
      role: "orchestrator",
      pid: 8000,
      parentPid: 1,
      startedAt: iso(t5),
      settledAt: iso(t5 + 20_000),
      wallMs: 20_000,
      waitingMs: 0,
      workMs: 20_000,
      // The orchestrator's own real turn usage — nothing else. An
      // ambiguous span never contributes forwardedUsage (C1), even though
      // a real "subagent" tool call happened (see `tools`/`subagents`
      // below, mirroring what WorkTracker.onToolStart/onToolEnd actually
      // produce for a genuinely ambiguous tool-name match).
      usage: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.05 },
      costObserved: true,
      runs: 1,
      turns: 1,
      tools: { subagent: 1 },
      subagents: [{ toolCallId: "call-ambiguous-1", agent: "unknown", mode: "task", ms: 5_000 }],
    });
    worktreeALog.append(ambiguousTask);

    const summary10 = await runSync(
      { log: worktreeALog, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      {},
    );
    assert.equal(summary10.error, undefined, `ambiguous-subagent sync should not error: ${summary10.error}`);
    const ambiguousRow = await findTaskEntry(superuserToken, "task-ambiguous-subagent");
    assert.equal(ambiguousRow["input"], 200, "an ambiguous span must never add anything to input");
    assert.equal(ambiguousRow["output"], 80, "an ambiguous span must never add anything to output");
    assert.ok(Math.abs((ambiguousRow["cost"] as number) - 0.05) < 1e-9, "hub row cost must equal ONLY the orchestrator's own observed turn cost — unchanged by the ambiguous call");
    assert.equal(ambiguousRow["subagent_count"], 0, "no child record was ever joined for this span");
    assert.equal(ambiguousRow["subagent_linkage"], "unlinked");
    log("  task-ambiguous-subagent: hub row cost unchanged by the ambiguous call — verified");

    // --- C1 (CRITICAL fix) scenario B: a configured tool whose child IS
    // joined (a confirmed child-env marker fired for that same child
    // process, so it became its own subagent-role WorkRecord in this same
    // worklog, ancestry-joined by matchChildren) AND whose result ALSO
    // carried `usage` (the configured profile's own documented residual
    // risk — see buildConfiguredProfile's doc comment). The joined child's
    // own `usage` must count; the orchestrator span's `forwardedUsage` for
    // the SAME profile must be excluded — counted exactly once, not twice
    // (the runtime guard domain/task-view.ts#unjoinedForwardedUsage adds). ---
    log("C1 scenario B: a configured tool with a joined child AND forwarded usage is counted exactly once");
    const t6 = Date.parse("2026-09-19T16:00:00.000Z");
    const joinedParent = makeRecord({
      id: "task-configured-joined",
      role: "orchestrator",
      pid: 9000,
      parentPid: 1,
      startedAt: iso(t6),
      settledAt: iso(t6 + 30_000),
      wallMs: 30_000,
      waitingMs: 0,
      workMs: 30_000,
      usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.005 },
      costObserved: true,
      runs: 1,
      turns: 1,
      tools: { my_review_tool: 1 },
      subagents: [
        {
          toolCallId: "call-configured-joined-1",
          agent: "reviewer",
          mode: "task",
          ms: 10_000,
          profile: "configured",
          // The SAME cost the joined child below also independently
          // observed — if this were added on top, the hub row would be
          // billed twice for the same nested work.
          forwardedUsage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 1.5 },
        },
      ],
    });
    const joinedChild = makeRecord({
      id: "task-configured-joined-child",
      role: "subagent",
      pid: 9001,
      parentPid: 9000,
      project: "/repo/e2e-project",
      startedAt: iso(t6 + 1_000),
      settledAt: iso(t6 + 20_000),
      wallMs: 19_000,
      waitingMs: 0,
      workMs: 19_000,
      usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 1.5 },
      costObserved: true,
      profile: "configured",
    });
    worktreeALog.append(joinedParent);
    worktreeALog.append(joinedChild);

    const summary11 = await runSync(
      { log: worktreeALog, sink: makeSink(), stateStore, clock: { now: () => Date.now() }, target: PB_URL, windowHours: 24 },
      {},
    );
    assert.equal(summary11.error, undefined, `configured-tool-with-joined-child sync should not error: ${summary11.error}`);
    const joinedRow = await findTaskEntry(superuserToken, "task-configured-joined");
    assert.equal(joinedRow["input"], 550, "50 (orchestrator) + 500 (child, once) — never + the span's own forwardedUsage on top");
    assert.equal(joinedRow["output"], 220);
    assert.ok(Math.abs((joinedRow["cost"] as number) - 1.505) < 1e-9, "cost counted exactly once: 0.005 (orchestrator) + 1.5 (child) — the span's forwardedUsage excluded");
    assert.equal(joinedRow["subagent_count"], 1, "exactly one child record was joined");
    assert.equal(joinedRow["subagent_linkage"], "linked");
    assert.equal(await countWorkRecords(superuserToken, joinedRow["id"] as string), 2, "both the orchestrator's own and the joined child's work_records rows");
    log("  task-configured-joined: forwarded usage excluded in favour of the joined child's own usage — counted once, verified");

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
