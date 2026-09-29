import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PocketBaseClient, PocketBaseError } from "kankaku-pi/hub";
import { applyReassignment, createReassignActions, describeHubError, fetchHubRows } from "../src/adapters/hub-reassign.ts";
import type { ReassignPlan } from "../src/domain/reassign-model.ts";

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: FakeCall) => Response | Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function page(items: unknown[]): Response {
  return jsonResponse(200, { page: 1, perPage: 200, totalItems: items.length, totalPages: 1, items });
}

function fakeFetch(calls: FakeCall[], handler: Handler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FakeCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return handler(call);
  }) as typeof fetch;
}

function withAuth(handler: Handler): Handler {
  return (call) => (call.url.endsWith("/api/collections/users/auth-with-password") ? jsonResponse(200, { token: "tok", record: { id: "u1" } }) : handler(call));
}

function makeClient(calls: FakeCall[], handler: Handler, timeoutMs?: number): PocketBaseClient {
  return new PocketBaseClient({
    url: "https://hub.test",
    email: "svc@x",
    password: "pw",
    fetch: fakeFetch(calls, withAuth(handler)),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

function entry(taskId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `row-${taskId}`, task_id: taskId, client: "c-sin", project: "", task: "", ...overrides };
}

test("fetchHubRows filters on task_id and maps rows by kankaku task id, tolerating empty relations", async () => {
  const calls: FakeCall[] = [];
  const client = makeClient(calls, () => page([entry("t1"), entry("t2", { client: "c-acme", project: "p-web", task: "h-login" })]));
  const rows = await fetchHubRows(client, ["t1", "t2", "t3"]);

  const lookups = calls.filter((call) => call.url.includes("/task_entries/records"));
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0]?.method, "GET");
  assert.equal(new URL(lookups[0]!.url).pathname, "/api/collections/task_entries/records");
  assert.equal(queryOf(lookups[0]!.url).get("filter"), 'task_id="t1"||task_id="t2"||task_id="t3"');
  assert.deepEqual(rows.get("t1"), { rowId: "row-t1", taskId: "t1", clientId: "c-sin", projectId: "", hubTaskId: "" });
  assert.deepEqual(rows.get("t2"), { rowId: "row-t2", taskId: "t2", clientId: "c-acme", projectId: "p-web", hubTaskId: "h-login" });
  assert.equal(rows.has("t3"), false);
});

test("fetchHubRows sends the token the client obtained in the Authorization header", async () => {
  const calls: FakeCall[] = [];
  const client = makeClient(calls, () => page([]));
  await fetchHubRows(client, ["t1"]);
  const lookup = calls.find((call) => call.url.includes("/task_entries/records"));
  assert.equal(lookup?.headers["Authorization"], "tok");
  assert.equal(calls[0]?.url, "https://hub.test/api/collections/users/auth-with-password");
});

test("fetchHubRows asks in chunks of 30 and escapes quotes and backslashes in ids", async () => {
  const calls: FakeCall[] = [];
  const client = makeClient(calls, () => page([]));
  const ids = Array.from({ length: 65 }, (_, index) => `id${index}`);
  ids[0] = 'we"ird\\id';
  await fetchHubRows(client, ids);
  const lookups = calls.filter((call) => call.url.includes("/task_entries/records"));
  assert.equal(lookups.length, 3);
  const sizes = lookups.map((call) => queryOf(call.url).get("filter")!.split("||").length);
  assert.deepEqual(sizes, [30, 30, 5]);
  assert.ok(queryOf(lookups[0]!.url).get("filter")!.startsWith('task_id="we\\"ird\\\\id"||'));
});

test("fetchHubRows makes no request for an empty list", async () => {
  const calls: FakeCall[] = [];
  const rows = await fetchHubRows(makeClient(calls, () => page([])), []);
  assert.equal(rows.size, 0);
  assert.equal(calls.length, 0);
});

test("fetchHubRows ignores rows without a string task_id and non-string relations", async () => {
  const client = makeClient([], () => page([{ id: "x" }, entry("t1", { client: null, project: ["a"], task: 3 })]));
  const rows = await fetchHubRows(client, ["t1"]);
  assert.deepEqual([...rows.keys()], ["t1"]);
  assert.deepEqual(rows.get("t1"), { rowId: "row-t1", taskId: "t1", clientId: "", projectId: "", hubTaskId: "" });
});

test("fetchHubRows lets a hub failure propagate", async () => {
  const client = makeClient([], () => jsonResponse(500, { message: "boom" }));
  await assert.rejects(fetchHubRows(client, ["t1"]), /500/);
});

function planOf(...lines: ReassignPlan["lines"]): ReassignPlan {
  return { mode: "single", destination: "Acme", lines };
}

function reassignLine(taskId: string, payload = { client: "c-acme", project: "", task: "" }): ReassignPlan["lines"][number] {
  return { kind: "reassign", taskId, label: taskId, rowId: `row-${taskId}`, from: "unassigned", to: "Acme", payload };
}

test("applyReassignment sends one PATCH per reassign line with exactly {client, project, task}", async () => {
  const calls: FakeCall[] = [];
  const client = makeClient(calls, () => jsonResponse(200, { id: "ok" }));
  const outcomes = await applyReassignment(
    client,
    planOf(
      reassignLine("t1", { client: "c-acme", project: "p-web", task: "h-login" }),
      reassignLine("t2", { client: "c-acme", project: "", task: "" }),
    ),
  );
  const patches = calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(
    patches.map((call) => [new URL(call.url).pathname, call.body]),
    [
      ["/api/collections/task_entries/records/row-t1", { client: "c-acme", project: "p-web", task: "h-login" }],
      ["/api/collections/task_entries/records/row-t2", { client: "c-acme", project: "", task: "" }],
    ],
  );
  assert.deepEqual(Object.keys(patches[0]!.body as object), ["client", "project", "task"]);
  assert.equal(patches[0]?.headers["Authorization"], "tok");
  assert.deepEqual(outcomes, [
    { taskId: "t1", status: "reassigned" },
    { taskId: "t2", status: "reassigned" },
  ]);
});

test("applyReassignment never sends legacy_client_label or a measurement field", async () => {
  const calls: FakeCall[] = [];
  await applyReassignment(makeClient(calls, () => jsonResponse(200, {})), planOf(reassignLine("t1")));
  const body = calls.find((call) => call.method === "PATCH")?.body as Record<string, unknown>;
  for (const forbidden of ["legacy_client_label", "wall_ms", "work_ms", "waiting_ms", "cost", "prompt", "status", "started_at", "task_id"]) {
    assert.equal(forbidden in body, false, forbidden);
  }
});

test("applyReassignment ignores unchanged and skipped lines", async () => {
  const calls: FakeCall[] = [];
  const outcomes = await applyReassignment(
    makeClient(calls, () => jsonResponse(200, {})),
    planOf(
      { kind: "unchanged", taskId: "t1", label: "t1", at: "Acme" },
      { kind: "skipped", taskId: "t2", label: "t2", reason: "already assigned" },
    ),
  );
  assert.deepEqual(outcomes, []);
  assert.equal(calls.length, 0);
});

test("a 400, a 403 and a network failure on single rows do not stop the rest", async () => {
  const calls: FakeCall[] = [];
  const client = makeClient(calls, (call) => {
    if (call.url.endsWith("row-t1")) return jsonResponse(400, { message: "bad" });
    if (call.url.endsWith("row-t2")) return jsonResponse(403, { message: "no" });
    if (call.url.endsWith("row-t3")) throw new TypeError("socket hang up");
    return jsonResponse(200, {});
  });
  const outcomes = await applyReassignment(client, planOf(reassignLine("t1"), reassignLine("t2"), reassignLine("t3"), reassignLine("t4")));
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 4);
  assert.deepEqual(outcomes, [
    { taskId: "t1", status: "failed", reason: "the hub rejected the change (400)" },
    { taskId: "t2", status: "failed", reason: "not allowed to change this row (403)" },
    { taskId: "t3", status: "failed", reason: "the hub is unreachable" },
    { taskId: "t4", status: "reassigned" },
  ]);
});

test("a request that never answers fails after the client's own time bound and the rest still run", async () => {
  const calls: FakeCall[] = [];
  const client = new PocketBaseClient({
    url: "https://hub.test",
    email: "svc@x",
    password: "pw",
    timeoutMs: 20,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", headers: {}, body: undefined });
      if (url.endsWith("/auth-with-password")) return jsonResponse(200, { token: "tok", record: { id: "u" } });
      if (url.endsWith("row-t1")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      }
      return jsonResponse(200, {});
    }) as typeof fetch,
  });
  const outcomes = await applyReassignment(client, planOf(reassignLine("t1"), reassignLine("t2")));
  assert.deepEqual(outcomes, [
    { taskId: "t1", status: "failed", reason: "the request timed out" },
    { taskId: "t2", status: "reassigned" },
  ]);
});

test("rejected credentials fail every row with the credentials reason", async () => {
  const client = new PocketBaseClient({
    url: "https://hub.test",
    email: "svc@x",
    password: "pw",
    fetch: (async () => jsonResponse(401, { message: "no" })) as typeof fetch,
  });
  const outcomes = await applyReassignment(client, planOf(reassignLine("t1"), reassignLine("t2")));
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status === "failed" && outcome.reason),
    ["the hub rejected the credentials", "the hub rejected the credentials"],
  );
});

test("describeHubError maps the client's error kinds to plain reasons", () => {
  assert.equal(describeHubError(new Error("plain")), "plain");
  assert.equal(describeHubError("odd"), "odd");
  assert.equal(describeHubError(new PocketBaseError("auth", "x", 401)), "the hub rejected the credentials");
  assert.equal(describeHubError(new PocketBaseError("timeout", "x")), "the request timed out");
  assert.equal(describeHubError(new PocketBaseError("network", "x")), "the hub is unreachable");
  assert.equal(describeHubError(new PocketBaseError("http", "x", 404)), "the row no longer exists on the hub (404)");
  assert.equal(describeHubError(new PocketBaseError("http", "x", 503)), "the hub answered 503");
  assert.doesNotMatch(describeHubError(new PocketBaseError("http", "kankaku: PATCH /api/collections/task_entries/records/abc (503)", 503)), /abc|api/);
});

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-reassign-"));
}

const CREDENTIALS = { url: "https://hub.test", email: "svc@x", password: "pw" };

function hubHandler(overrides: Handler = () => jsonResponse(404, {})): Handler {
  return (call) => {
    const path = new URL(call.url).pathname;
    if (path === "/api/collections/clients/records") return page([{ id: "c-acme", name: "Acme", code: "ACM", active: true }]);
    if (path === "/api/collections/projects/records") return page([]);
    if (path === "/api/collections/tasks/records") return page([]);
    if (path === "/api/collections/task_entries/records" && call.method === "GET") return page([entry("t1")]);
    return overrides(call);
  };
}

test("prepare returns the rows and a freshly fetched catalog", async () => {
  const home = tmpHome();
  try {
    const calls: FakeCall[] = [];
    const actions = createReassignActions(CREDENTIALS, { homeDir: () => home, now: () => 1000, fetch: fakeFetch(calls, withAuth(hubHandler())) });
    const result = await actions.prepare(["t1"]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.catalog.clients.map((c) => c.id), ["c-acme"]);
    assert.equal(result.rows.get("t1")?.rowId, "row-t1");
    assert.ok(calls.some((call) => call.url.includes("/api/collections/clients/records")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prepare reports rejected credentials as a message, without throwing", async () => {
  const home = tmpHome();
  try {
    const actions = createReassignActions(CREDENTIALS, { homeDir: () => home, now: () => 1000, fetch: (async () => jsonResponse(401, {})) as typeof fetch });
    const result = await actions.prepare(["t1"]);
    assert.deepEqual(result, { ok: false, message: "the hub rejected the credentials" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prepare reports an unreachable hub as a message", async () => {
  const home = tmpHome();
  try {
    const actions = createReassignActions(CREDENTIALS, {
      homeDir: () => home,
      now: () => 1000,
      fetch: (async () => {
        throw new TypeError("connect ECONNREFUSED");
      }) as typeof fetch,
    });
    const result = await actions.prepare(["t1"]);
    assert.deepEqual(result, { ok: false, message: "the hub is unreachable" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prepare fails when the catalog cannot be refreshed", async () => {
  const home = tmpHome();
  try {
    const actions = createReassignActions(CREDENTIALS, {
      homeDir: () => home,
      now: () => 1000,
      fetch: fakeFetch([], withAuth((call) => (new URL(call.url).pathname === "/api/collections/task_entries/records" ? page([entry("t1")]) : jsonResponse(500, {})))),
    });
    const result = await actions.prepare(["t1"]);
    assert.deepEqual(result, { ok: false, message: "could not refresh the catalog from the hub" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("apply patches the rows and then refreshes the catalog", async () => {
  const home = tmpHome();
  try {
    const calls: FakeCall[] = [];
    const actions = createReassignActions(CREDENTIALS, {
      homeDir: () => home,
      now: () => 1000,
      fetch: fakeFetch(calls, withAuth(hubHandler(() => jsonResponse(200, {})))),
    });
    const outcomes = await actions.apply(planOf(reassignLine("t1")));
    assert.deepEqual(outcomes, [{ taskId: "t1", status: "reassigned" }]);
    const order = calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
    const patchAt = order.indexOf("PATCH /api/collections/task_entries/records/row-t1");
    const refreshAt = order.indexOf("GET /api/collections/clients/records");
    assert.ok(patchAt >= 0 && refreshAt > patchAt, order.join("\n"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
