import assert from "node:assert/strict";
import { test } from "node:test";
import { PocketBaseSink, escapeFilterValue } from "../src/adapters/pocketbase-sink.ts";
import { PocketBaseError } from "../src/adapters/pocketbase-client.ts";
import type { PocketBaseClient } from "../src/adapters/pocketbase-client.ts";
import type { TaskView } from "../src/domain/task-view.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";
import type { Client, Project } from "../src/domain/work-target.ts";

function iso(secondsFromEpoch: number): string {
  return new Date(secondsFromEpoch * 1000).toISOString();
}

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec-1",
    role: "orchestrator",
    pid: 100,
    parentPid: 1,
    project: "/repo/proj",
    prompt: "do the thing",
    startedAt: iso(0),
    settledAt: iso(10),
    wallMs: 10000,
    waitingMs: 0,
    workMs: 10000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    status: "completed",
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskView> = {}, orchestratorOverrides: Partial<WorkRecord> = {}): TaskView {
  const orchestrator = makeRecord(orchestratorOverrides);
  return {
    id: orchestrator.id,
    project: orchestrator.project,
    prompt: orchestrator.prompt,
    startedAt: orchestrator.startedAt,
    endedAt: orchestrator.settledAt,
    wallMs: orchestrator.wallMs,
    waitingMs: orchestrator.waitingMs,
    workMs: orchestrator.workMs,
    status: orchestrator.status,
    orchestrator,
    subagents: [],
    usage: orchestrator.usage,
    segments: {},
    ...overrides,
  };
}

/** Minimal in-memory PocketBase stand-in: enough filter/unique-index/create/patch behaviour to exercise PocketBaseSink. */
function createFakeClient() {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  let nextId = 1;
  let pendingFailure: PocketBaseError | undefined;
  const listCalls: string[] = [];
  /** One-shot: on the next create for `collection`/`uniqueField` = a matching value, insert `record` first (simulating a concurrent writer), then fail with a unique-violation-shaped 400. */
  let raceOnCreate: { collection: string; uniqueField: string; record: Record<string, unknown> } | undefined;

  function collectionFor(name: string): Map<string, Record<string, unknown>> {
    let map = collections.get(name);
    if (!map) {
      map = new Map();
      collections.set(name, map);
    }
    return map;
  }

  function matchesFilter(record: Record<string, unknown>, filter: string): boolean {
    return filter.split("||").some((clause) => {
      const match = /^(\w+)="((?:[^"\\]|\\.)*)"$/.exec(clause.trim());
      if (!match) return false;
      const [, field, rawValue] = match;
      const value = rawValue!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      return record[field!] === value;
    });
  }

  const client = {
    async list(collection: string, opts: { filter?: string } = {}) {
      listCalls.push(collection);
      const items = Array.from(collectionFor(collection).values());
      if (!opts.filter) return items;
      return items.filter((item) => matchesFilter(item, opts.filter!));
    },
    async request(method: string, path: string, body?: unknown) {
      if (pendingFailure) {
        const error = pendingFailure;
        pendingFailure = undefined;
        throw error;
      }

      const match = /^\/api\/collections\/([^/]+)\/records(?:\/([^/]+))?$/.exec(path);
      if (!match) throw new Error(`unhandled path: ${path}`);
      const [, collection, id] = match;
      const map = collectionFor(collection!);

      if (method === "POST") {
        const uniqueField = collection === "task_entries" ? "task_id" : "kankaku_id";
        const value = (body as Record<string, unknown>)[uniqueField];

        if (raceOnCreate && raceOnCreate.collection === collection && raceOnCreate.record[uniqueField] === value) {
          const racing = raceOnCreate.record;
          raceOnCreate = undefined;
          const newId = `id-${nextId++}`;
          map.set(newId, { id: newId, ...racing });
          throw new PocketBaseError("http", "Failed to create record.", 400);
        }

        for (const existing of map.values()) {
          if (existing[uniqueField] === value) {
            throw new PocketBaseError("http", "Failed to create record.", 400);
          }
        }
        const newId = `id-${nextId++}`;
        const record = { id: newId, ...(body as Record<string, unknown>) };
        map.set(newId, record);
        return record;
      }

      if (method === "PATCH") {
        const existing = map.get(id!);
        if (!existing) throw new PocketBaseError("http", "not found", 404);
        const updated = { ...existing, ...(body as Record<string, unknown>) };
        map.set(id!, updated);
        return updated;
      }

      throw new Error(`unhandled method: ${method}`);
    },
  };

  return {
    client: client as unknown as PocketBaseClient,
    collections,
    listCalls,
    failNext: (error: PocketBaseError) => {
      pendingFailure = error;
    },
    simulateRaceOnCreate: (collection: string, uniqueField: string, record: Record<string, unknown>) => {
      raceOnCreate = { collection, uniqueField, record };
    },
  };
}

const client: Client = { id: "client-1", name: "Acme", code: "acme", active: true };
const unassignedClient: Client = { id: "client-unassigned", name: "Sin determinar", code: "sin-determinar", active: true, unassigned: true };
const project: Project = { id: "project-1", name: "Portal", clientId: "client-1", repoPaths: [], active: true };

function makeSink(overrides: Partial<{ syncRecords: boolean; chunkSize: number }> = {}, fake = createFakeClient()) {
  const sink = new PocketBaseSink({
    client: fake.client,
    clients: [client, unassignedClient],
    projects: [project],
    machine: "laptop",
    promptMode: "none",
    syncRecords: overrides.syncRecords ?? true,
    ...(overrides.chunkSize !== undefined ? { chunkSize: overrides.chunkSize } : {}),
  });
  return { sink, fake };
}

test("push creates a new task_entries row and reports 'created'", async () => {
  const { sink, fake } = makeSink();
  const task = makeTask({ clientId: "client-1", projectId: "project-1" });

  const results = await sink.push([task]);

  assert.deepEqual(results, [{ taskId: task.id, outcome: { kind: "created", unassigned: false } }]);
  const rows = Array.from(fake.collections.get("task_entries")!.values());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["task_id"], task.id);
  assert.equal(rows[0]!["client"], "client-1");
  assert.equal(rows[0]!["project"], "project-1");
});

test("push sends agent/plugin identity and measurement-quality fields, defaulting agent/plugin when not injected", async () => {
  const { sink, fake } = makeSink();
  const task = makeTask({ clientId: "client-1" });

  await sink.push([task]);

  const [row] = Array.from(fake.collections.get("task_entries")!.values());
  assert.equal(row!["agent"], "pi");
  assert.equal(row!["plugin"], "kankaku");
  assert.equal(row!["waiting_quality"], "measured");
  assert.equal(row!["cost_quality"], "unknown"); // makeRecord's default record never sets costObserved
  assert.equal(row!["subagent_linkage"], "not_applicable");
  // agent_version/plugin_version were never injected here — omitted, not guessed.
  assert.equal("agent_version" in row!, false);
  assert.equal("plugin_version" in row!, false);
});

test("push sends agent_version/plugin_version when injected, on both create and update", async () => {
  const fake = createFakeClient();
  const sink = new PocketBaseSink({
    client: fake.client,
    clients: [client, unassignedClient],
    projects: [project],
    machine: "laptop",
    promptMode: "none",
    syncRecords: true,
    agent: "pi",
    agentVersion: "0.85.1",
    plugin: "kankaku",
    pluginVersion: "0.4.6",
  });
  const task = makeTask({ clientId: "client-1" });

  await sink.push([task]); // create
  await sink.push([task]); // update (same task_id, already exists)

  const [row] = Array.from(fake.collections.get("task_entries")!.values());
  assert.equal(row!["agent_version"], "0.85.1");
  assert.equal(row!["plugin_version"], "0.4.6");
});

// ASSUMPTION (verified by the hub team, see kankaku-hub docs/contract.md
// "Agent and measurement quality"): PocketBase's REST API silently ignores
// unknown/unrecognized fields on create and update — it never rejects a
// request just because it carries a field an older schema (predating
// migration 1758300013) does not have. kankaku can therefore always send
// these fields without probing hub capability first; an older hub simply
// drops them with a 200, exactly like `createFakeClient` above, which
// accepts any body shape with no schema validation at all.
test("an older hub without the agent/quality fields still accepts the row (fields are additive, never required by this client)", async () => {
  const { sink } = makeSink();
  const task = makeTask({ clientId: "client-1" });

  const results = await sink.push([task]);

  assert.equal(results[0]!.outcome.kind, "created");
});

test("push reports routing to the unassigned client, with its legacy label, in the outcome", async () => {
  const { sink } = makeSink();
  const task = makeTask({ client: "cajamar" });

  const results = await sink.push([task]);

  assert.deepEqual(results, [{ taskId: task.id, outcome: { kind: "created", unassigned: true, legacyLabel: "cajamar" } }]);
});

test("push also creates work_records children linked to the task_entries row when syncRecords is enabled", async () => {
  const child = makeRecord({ id: "child-1", role: "subagent", pid: 200, parentPid: 100 });
  const { sink, fake } = makeSink({ syncRecords: true });
  const task = makeTask({ subagents: [child] });

  await sink.push([task]);

  const taskEntryId = Array.from(fake.collections.get("task_entries")!.values())[0]!["id"];
  const records = Array.from(fake.collections.get("work_records")!.values());
  assert.equal(records.length, 2); // orchestrator + child
  assert.ok(records.every((r) => r["task_entry"] === taskEntryId));
  assert.ok(records.some((r) => r["kankaku_id"] === task.orchestrator.id));
  assert.ok(records.some((r) => r["kankaku_id"] === "child-1"));
});

test("push does not touch work_records when syncRecords is disabled", async () => {
  const { sink, fake } = makeSink({ syncRecords: false });
  await sink.push([makeTask()]);
  assert.equal(fake.collections.get("work_records"), undefined);
});

test("push updates an existing task_entries row without resending assignment fields", async () => {
  const { sink, fake } = makeSink();
  const task = makeTask({ clientId: "client-1" });

  await sink.push([task]); // create
  const changed = makeTask({ clientId: "client-1", wallMs: 99999 }, { id: task.id, wallMs: 99999 });
  const results = await sink.push([changed]); // update

  assert.deepEqual(results, [{ taskId: task.id, outcome: { kind: "updated", unassigned: false } }]);
  const rows = Array.from(fake.collections.get("task_entries")!.values());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["wall_ms"], 99999);
  // The update request never carried these keys, so the original create-time values survive.
  assert.equal(rows[0]!["client"], "client-1");
});

test("CRITICAL: a re-sync never undoes a reassignment made directly against PocketBase", async () => {
  const { sink, fake } = makeSink();
  const task = makeTask({}); // unassigned at first sync

  await sink.push([task]);
  const created = Array.from(fake.collections.get("task_entries")!.values())[0]!;

  // Simulate the owner reassigning the row in the web.
  created["client"] = "client-1";
  created["project"] = "project-1";
  created["legacy_client_label"] = "";

  // Same local task, still unassigned locally, re-synced (e.g. content changed).
  const changed = makeTask({}, { id: task.id, wallMs: 55555 });
  await sink.push([changed]);

  const after = fake.collections.get("task_entries")!.get(created["id"] as string)!;
  assert.equal(after["client"], "client-1");
  assert.equal(after["project"], "project-1");
  assert.equal(after["wall_ms"], 55555);
});

test("a create-time unique violation (race) falls back to look-up-then-patch", async () => {
  const { sink, fake } = makeSink();
  const task = makeTask();

  // Our upfront lookup finds nothing; a concurrent writer creates the row
  // in the window between that lookup and our own create attempt.
  fake.simulateRaceOnCreate("task_entries", "task_id", { task_id: task.id, wall_ms: 1 });

  const results = await sink.push([task]);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.outcome.kind, "updated");
  const rows = Array.from(fake.collections.get("task_entries")!.values());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["wall_ms"], task.wallMs);
});

test("a genuine validation failure on create is recorded as 'failed', not 'error', and does not stop the run", async () => {
  const { sink, fake } = makeSink();
  fake.failNext(new PocketBaseError("http", "Failed to create record.", 400));
  const first = makeTask({}, { id: "bad-task" });
  const second = makeTask({}, { id: "good-task" });

  const results = await sink.push([first, second]);

  assert.equal(results.length, 2);
  assert.equal(results[0]!.outcome.kind, "failed");
  assert.equal(results[1]!.outcome.kind, "created");
});

test("a network error stops the run and does not attempt later tasks", async () => {
  const { sink, fake } = makeSink();
  const first = makeTask({}, { id: "first" });
  const second = makeTask({}, { id: "second" });

  // Let the upfront lookup succeed, then fail the first create with a network error.
  fake.failNext(new PocketBaseError("network", "kankaku: hub request failed"));

  const results = await sink.push([first, second]);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.taskId, "first");
  assert.equal(results[0]!.outcome.kind, "error");
});

test("a 5xx error is treated as fatal and stops the run", async () => {
  const { sink, fake } = makeSink();
  fake.failNext(new PocketBaseError("http", "server error", 500));

  const results = await sink.push([makeTask()]);

  assert.equal(results[0]!.outcome.kind, "error");
});

test("push looks up existing task_entries rows in chunks of the configured size", async () => {
  const { sink, fake } = makeSink({ chunkSize: 2 });
  const tasks = [
    makeTask({}, { id: "t1" }),
    makeTask({}, { id: "t2" }),
    makeTask({}, { id: "t3" }),
    makeTask({}, { id: "t4" }),
    makeTask({}, { id: "t5" }),
  ];

  await sink.push(tasks);

  const taskEntryLookups = fake.listCalls.filter((collection) => collection === "task_entries").length;
  assert.equal(taskEntryLookups, 3); // ceil(5/2)
});

test("push returns [] for an empty task list without any request", async () => {
  const { sink, fake } = makeSink();
  const results = await sink.push([]);
  assert.deepEqual(results, []);
  assert.equal(fake.listCalls.length, 0);
});

test("escapeFilterValue escapes a double quote", () => {
  assert.equal(escapeFilterValue('a"b'), 'a\\"b');
});

test("escapeFilterValue escapes a backslash", () => {
  assert.equal(escapeFilterValue("a\\b"), "a\\\\b");
});

test("escapeFilterValue escapes a value with both a quote and a backslash, backslashes first so the quote's own escape is not re-escaped", () => {
  assert.equal(escapeFilterValue('a\\"b'), 'a\\\\\\"b');
});

test("escapeFilterValue escapes a trailing backslash so it cannot swallow the filter's closing quote", () => {
  assert.equal(escapeFilterValue("a\\"), "a\\\\");
});

test("escapeFilterValue on an already-escaped-looking value still doubles every backslash (no double-unescaping)", () => {
  assert.equal(escapeFilterValue('\\"'), '\\\\\\"');
});

test("push escapes a task id containing a quote so it cannot break out of the filter's string literal and corrupt an unrelated lookup", async () => {
  const { sink, fake } = makeSink();

  // A pre-existing, unrelated row this attack would try to match if the
  // filter were built by naive concatenation instead of proper escaping.
  const victim = makeTask({}, { id: "y" });
  await sink.push([victim]);

  const maliciousId = 'x" || task_id="y';
  const malicious = makeTask({}, { id: maliciousId });
  const results = await sink.push([malicious]);

  assert.deepEqual(results, [{ taskId: maliciousId, outcome: { kind: "created", unassigned: true } }]);

  const rows = Array.from(fake.collections.get("task_entries")!.values());
  assert.equal(rows.length, 2); // the victim's row is untouched, and a genuinely new row was created
  assert.ok(rows.some((row) => row["task_id"] === "y"));
  assert.ok(rows.some((row) => row["task_id"] === maliciousId));
});
