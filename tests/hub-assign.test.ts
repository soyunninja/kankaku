import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHubAssignment } from "../src/domain/hub-assign.ts";
import { createHubAssign } from "../src/adapters/hub-assign.ts";
import type { SyncedTaskEntryRow } from "../src/adapters/hub-assign.ts";
import { formatAssignResultLines, formatAssignRowLabel } from "../src/adapters/hub-actions.ts";
import type { PocketBaseClient } from "../src/adapters/pocketbase-client.ts";
import type { CatalogSnapshot } from "../src/ports/catalog.ts";

const SNAPSHOT: CatalogSnapshot = {
  fetchedAt: 0,
  url: "https://pb.example.com",
  clients: [
    { id: "c-acme", name: "Acme", code: "acme", active: true },
    { id: "c-globex", name: "Globex", code: "globex", active: true },
    { id: "c-dormant", name: "Dormant", code: "dormant", active: false },
    { id: "c-sin", name: "Sin determinar", code: "sin", active: true, unassigned: true },
  ],
  projects: [
    { id: "p-portal", name: "Portal", code: "portal", clientId: "c-acme", repoPaths: [], active: true },
    { id: "p-app", name: "App", code: "app", clientId: "c-globex", repoPaths: [], active: true },
    { id: "p-legacy", name: "Legacy", code: "legacy", clientId: "c-acme", repoPaths: [], active: false },
  ],
};

test("resolveHubAssignment resolves a client by code and a project by name, case-insensitively", () => {
  const result = resolveHubAssignment(SNAPSHOT, "ACME", "portal");
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.deepEqual(result.payload, { client: "c-acme", project: "p-portal" });
  assert.equal(result.client.name, "Acme");
  assert.equal(result.project?.name, "Portal");
});

test("resolveHubAssignment resolves a client by name and clears the project when none is given", () => {
  const result = resolveHubAssignment(SNAPSHOT, "globex", undefined);
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.deepEqual(result.payload, { client: "c-globex", project: "" });
  assert.equal(result.project, undefined);
});

test("resolveHubAssignment builds a payload with exactly the client/project pair", () => {
  const result = resolveHubAssignment(SNAPSHOT, "acme", "portal");
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.deepEqual(Object.keys(result.payload).sort(), ["client", "project"]);
});

test("resolveHubAssignment returns client-not-found for an unknown reference", () => {
  const result = resolveHubAssignment(SNAPSHOT, "nope", undefined);
  assert.deepEqual(result, { kind: "client-not-found", reference: "nope" });
});

test("resolveHubAssignment never matches an inactive or unassigned client", () => {
  assert.deepEqual(resolveHubAssignment(SNAPSHOT, "dormant", undefined), { kind: "client-not-found", reference: "dormant" });
  assert.deepEqual(resolveHubAssignment(SNAPSHOT, "sin", undefined), { kind: "client-not-found", reference: "sin" });
  assert.deepEqual(resolveHubAssignment(SNAPSHOT, "Sin determinar", undefined), {
    kind: "client-not-found",
    reference: "Sin determinar",
  });
});

test("resolveHubAssignment returns project-not-found for an unknown or inactive project", () => {
  assert.deepEqual(resolveHubAssignment(SNAPSHOT, "acme", "nope"), { kind: "project-not-found", reference: "nope" });
  assert.deepEqual(resolveHubAssignment(SNAPSHOT, "acme", "legacy"), { kind: "project-not-found", reference: "legacy" });
});

test("resolveHubAssignment returns project-not-in-client when the project belongs to another client", () => {
  const result = resolveHubAssignment(SNAPSHOT, "acme", "app");
  assert.equal(result.kind, "project-not-in-client");
  if (result.kind !== "project-not-in-client") return;
  assert.equal(result.reference, "app");
  assert.equal(result.client.id, "c-acme");
});

class FakePocketBaseClient {
  readonly requests: Array<{ method: string; path: string; body?: unknown }> = [];
  readonly listCalls: Array<{ collection: string; filter?: string; perPage?: number }> = [];
  listItems: Array<Record<string, unknown>> = [];
  requestResult: unknown = { page: 1, perPage: 20, totalItems: 0, totalPages: 0, items: [] };

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.requests.push({ method, path, ...(body !== undefined ? { body } : {}) });
    return this.requestResult as T;
  }

  async list<T>(collection: string, opts: { filter?: string; perPage?: number } = {}): Promise<T[]> {
    this.listCalls.push({ collection, ...opts });
    return this.listItems as T[];
  }
}

function fakeClient(): FakePocketBaseClient {
  return new FakePocketBaseClient();
}

function asClient(fake: FakePocketBaseClient): PocketBaseClient {
  return fake as unknown as PocketBaseClient;
}

test("listRecent asks for the newest page and maps only the documented fields", async () => {
  const fake = fakeClient();
  fake.requestResult = {
    page: 1,
    perPage: 5,
    totalItems: 1,
    totalPages: 1,
    items: [
      {
        id: "rec-1",
        task_id: "task-1",
        prompt: "hello",
        started_at: "2026-01-02 10:00:00.000Z",
        client: "c-acme",
        project: "p-portal",
        status: "completed",
        work_ms: 123,
      },
    ],
  };

  const rows = await createHubAssign({ client: asClient(fake) }).listRecent(5);

  assert.deepEqual(rows, [
    {
      id: "rec-1",
      taskId: "task-1",
      prompt: "hello",
      startedAt: "2026-01-02 10:00:00.000Z",
      client: "c-acme",
      project: "p-portal",
    },
  ]);
  assert.deepEqual(fake.requests, [
    { method: "GET", path: "/api/collections/task_entries/records?page=1&perPage=5&sort=-started_at" },
  ]);
});

test("listRecent defaults to 20 rows and omits fields a row does not carry", async () => {
  const fake = fakeClient();
  fake.requestResult = { page: 1, perPage: 20, totalItems: 1, totalPages: 1, items: [{ id: "rec-2", task_id: "task-2" }] };

  const rows = await createHubAssign({ client: asClient(fake) }).listRecent();

  assert.deepEqual(rows, [{ id: "rec-2", taskId: "task-2" }]);
  assert.deepEqual(fake.requests, [
    { method: "GET", path: "/api/collections/task_entries/records?page=1&perPage=20&sort=-started_at" },
  ]);
});

test("assign looks up the row by task_id and PATCHes exactly the client/project pair", async () => {
  const fake = fakeClient();
  fake.listItems = [{ id: "rec-9", task_id: "task-9" }];

  const outcome = await createHubAssign({ client: asClient(fake) }).assign("task-9", { client: "c-acme", project: "p-portal" });

  assert.deepEqual(outcome, { kind: "assigned", recordId: "rec-9" });
  assert.deepEqual(fake.listCalls, [{ collection: "task_entries", filter: 'task_id="task-9"', perPage: 1 }]);
  assert.deepEqual(fake.requests, [
    { method: "PATCH", path: "/api/collections/task_entries/records/rec-9", body: { client: "c-acme", project: "p-portal" } },
  ]);
});

test("assign escapes a task_id before using it in the filter", async () => {
  const fake = fakeClient();
  fake.listItems = [{ id: "rec-10", task_id: 'a"b\\c' }];

  await createHubAssign({ client: asClient(fake) }).assign('a"b\\c', { client: "c-acme", project: "" });

  assert.deepEqual(fake.listCalls, [{ collection: "task_entries", filter: 'task_id="a\\"b\\\\c"', perPage: 1 }]);
});

test("assign reports not-found and never PATCHes when no row matches", async () => {
  const fake = fakeClient();

  const outcome = await createHubAssign({ client: asClient(fake) }).assign("missing", { client: "c-acme", project: "" });

  assert.deepEqual(outcome, { kind: "not-found" });
  assert.deepEqual(fake.requests, []);
});

test("formatAssignRowLabel numbers the row, resolves names from the snapshot and keeps the task_id", () => {
  const row: SyncedTaskEntryRow = {
    id: "rec-1",
    taskId: "task-1",
    prompt: "hello",
    startedAt: "2026-01-02 10:00:00.000Z",
    client: "c-acme",
    project: "p-portal",
  };
  assert.equal(formatAssignRowLabel(row, 1, SNAPSHOT), "1. 2026-01-02 10:00:00.000Z — Acme · Portal — hello [task-1]");
});

test("formatAssignRowLabel falls back to raw ids and omits a missing prompt", () => {
  const row: SyncedTaskEntryRow = { id: "rec-2", taskId: "task-2", client: "c-unknown", project: "p-unknown" };
  assert.equal(formatAssignRowLabel(row, 2, SNAPSHOT), "2. unknown — c-unknown · p-unknown [task-2]");
});

test("formatAssignResultLines names the client (and project) the row was moved to", () => {
  assert.deepEqual(
    formatAssignResultLines({
      taskId: "task-1",
      client: { id: "c-acme", name: "Acme", code: "acme", active: true },
      project: { id: "p-portal", name: "Portal", code: "portal", clientId: "c-acme", repoPaths: [], active: true },
    }),
    ["assigned task-1 to Acme (acme) · Portal"],
  );
  assert.deepEqual(
    formatAssignResultLines({ taskId: "task-2", client: { id: "c-globex", name: "Globex", code: "globex", active: true } }),
    ["assigned task-2 to Globex (globex)"],
  );
});
