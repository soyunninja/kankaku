import assert from "node:assert/strict";
import { test } from "node:test";
import { PocketBaseClient, PocketBaseError } from "../src/adapters/pocketbase-client.ts";
import type { PocketBaseFetch } from "../src/adapters/pocketbase-client.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): PocketBaseFetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as PocketBaseFetch;
}

test("request authenticates lazily on the first call and sends the raw token, not Bearer", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = makeFetch((url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
    calls.push({ url, headers });
    if (url.endsWith("/api/collections/users/auth-with-password")) {
      assert.deepEqual(JSON.parse(String(init.body)), { identity: "bot@example.com", password: "secret" });
      return jsonResponse(200, { token: "tok-1", record: { id: "u1" } });
    }
    return jsonResponse(200, { ok: true });
  });

  const client = new PocketBaseClient({ url: "https://pb.example.com", email: "bot@example.com", password: "secret", fetch: fetchFn });
  const result = await client.request("GET", "/api/collections/clients/records");

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.headers["authorization"], "tok-1");
});

test("request reuses the token across calls without re-authenticating", async () => {
  let authCalls = 0;
  const fetchFn = makeFetch((url) => {
    if (url.includes("auth-with-password")) {
      authCalls += 1;
      return jsonResponse(200, { token: "tok-1", record: { id: "u1" } });
    }
    return jsonResponse(200, { ok: true });
  });

  const client = new PocketBaseClient({ url: "https://pb.example.com", email: "a@b.com", password: "x", fetch: fetchFn });
  await client.request("GET", "/a");
  await client.request("GET", "/b");

  assert.equal(authCalls, 1);
});

test("request re-authenticates once on a 401 and retries the original call", async () => {
  let authCalls = 0;
  let dataCalls = 0;
  const fetchFn = makeFetch((url) => {
    if (url.includes("auth-with-password")) {
      authCalls += 1;
      return jsonResponse(200, { token: `tok-${authCalls}`, record: { id: "u1" } });
    }
    dataCalls += 1;
    if (dataCalls === 1) return jsonResponse(401, { message: "expired" });
    return jsonResponse(200, { ok: true });
  });

  const client = new PocketBaseClient({ url: "https://pb.example.com", email: "a@b.com", password: "x", fetch: fetchFn });
  const result = await client.request("GET", "/api/collections/clients/records");

  assert.deepEqual(result, { ok: true });
  assert.equal(authCalls, 2);
  assert.equal(dataCalls, 2);
});

test("request throws a typed auth PocketBaseError when the retry after re-auth still 401s", async () => {
  const fetchFn = makeFetch((url) => {
    if (url.includes("auth-with-password")) return jsonResponse(200, { token: "tok", record: { id: "u1" } });
    return jsonResponse(401, { message: "still unauthorized" });
  });

  const client = new PocketBaseClient({ url: "https://pb.example.com", email: "a@b.com", password: "x", fetch: fetchFn });

  await assert.rejects(
    () => client.request("GET", "/api/collections/clients/records"),
    (error: unknown) => error instanceof PocketBaseError && error.kind === "auth" && error.status === 401,
  );
});

test("request throws a typed auth PocketBaseError when the initial authentication call fails", async () => {
  const fetchFn = makeFetch(() => jsonResponse(400, { message: "bad credentials" }));
  const client = new PocketBaseClient({ url: "https://pb.example.com", email: "a@b.com", password: "wrong", fetch: fetchFn });

  await assert.rejects(
    () => client.request("GET", "/x"),
    (error: unknown) => error instanceof PocketBaseError && error.kind === "auth",
  );
});

test("request throws a typed http PocketBaseError for a non-401, non-2xx response", async () => {
  const fetchFn = makeFetch((url) => {
    if (url.includes("auth-with-password")) return jsonResponse(200, { token: "tok", record: { id: "u1" } });
    return jsonResponse(500, { message: "boom" });
  });

  const client = new PocketBaseClient({ url: "https://pb.example.com", email: "a@b.com", password: "x", fetch: fetchFn });

  await assert.rejects(
    () => client.request("GET", "/x"),
    (error: unknown) => error instanceof PocketBaseError && error.kind === "http" && error.status === 500,
  );
});

test("request throws a typed network PocketBaseError when fetch rejects", async () => {
  const fetchFn: PocketBaseFetch = (async () => {
    throw new TypeError("fetch failed");
  }) as PocketBaseFetch;

  const client = new PocketBaseClient({ url: "https://pb.example.com", email: "a@b.com", password: "x", fetch: fetchFn });

  await assert.rejects(
    () => client.request("GET", "/x"),
    (error: unknown) => error instanceof PocketBaseError && error.kind === "network",
  );
});

test("request throws a typed timeout PocketBaseError when fetch aborts", async () => {
  const fetchFn: PocketBaseFetch = (async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }) as PocketBaseFetch;

  const client = new PocketBaseClient({ url: "https://pb.example.com", email: "a@b.com", password: "x", fetch: fetchFn, timeoutMs: 5 });

  await assert.rejects(
    () => client.request("GET", "/x"),
    (error: unknown) => error instanceof PocketBaseError && error.kind === "timeout",
  );
});

test("list paginates until every page is read and concatenates items", async () => {
  const fetchFn = makeFetch((url) => {
    if (url.includes("auth-with-password")) return jsonResponse(200, { token: "tok", record: { id: "u1" } });
    const page = Number(new URL(url).searchParams.get("page"));
    if (page === 1) {
      return jsonResponse(200, { page: 1, perPage: 2, totalItems: 3, totalPages: 2, items: [{ id: "a" }, { id: "b" }] });
    }
    return jsonResponse(200, { page: 2, perPage: 2, totalItems: 3, totalPages: 2, items: [{ id: "c" }] });
  });

  const client = new PocketBaseClient({ url: "https://pb.example.com", email: "a@b.com", password: "x", fetch: fetchFn });
  const items = await client.list("clients", { perPage: 2 });

  assert.deepEqual(
    items.map((item) => item.id),
    ["a", "b", "c"],
  );
});

test("list returns an empty array for an empty collection", async () => {
  const fetchFn = makeFetch((url) => {
    if (url.includes("auth-with-password")) return jsonResponse(200, { token: "tok", record: { id: "u1" } });
    return jsonResponse(200, { page: 1, perPage: 200, totalItems: 0, totalPages: 1, items: [] });
  });

  const client = new PocketBaseClient({ url: "https://pb.example.com", email: "a@b.com", password: "x", fetch: fetchFn });
  const items = await client.list("clients");

  assert.deepEqual(items, []);
});

test("list passes filter and sort through as query params", async () => {
  let capturedUrl = "";
  const fetchFn = makeFetch((url) => {
    if (url.includes("auth-with-password")) return jsonResponse(200, { token: "tok", record: { id: "u1" } });
    capturedUrl = url;
    return jsonResponse(200, { page: 1, perPage: 200, totalItems: 0, totalPages: 1, items: [] });
  });

  const client = new PocketBaseClient({ url: "https://pb.example.com", email: "a@b.com", password: "x", fetch: fetchFn });
  await client.list("projects", { filter: "active=true", sort: "name" });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.searchParams.get("filter"), "active=true");
  assert.equal(parsed.searchParams.get("sort"), "name");
});
