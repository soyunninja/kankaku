import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertSuperuser, createUser } from "../src/adapters/hub-manager/accounts.ts";
import type { ScriptRunner, ScriptRunResult } from "../src/ports/script-runner.ts";

interface RunCall {
  cmd: string;
  args: string[];
  cwd: string;
}

function fakeRunner(result: ScriptRunResult): { runner: ScriptRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const runner: ScriptRunner = {
    async run(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts.cwd });
      return result;
    },
    spawnDetached() {
      throw new Error("not used in accounts tests");
    },
  };
  return { runner, calls };
}

test("upsertSuperuser: runs 'pocketbase superuser upsert <email> <password> --dir <pbData>'", async () => {
  const { runner, calls } = fakeRunner({ code: 0, stdout: "", stderr: "" });
  await upsertSuperuser("/hub/bin/pocketbase", "/hub/pb_data", "owner@example.test", "s3cret", runner);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, "/hub/bin/pocketbase");
  assert.deepEqual(calls[0]!.args, ["superuser", "upsert", "owner@example.test", "s3cret", "--dir", "/hub/pb_data"]);
});

test("upsertSuperuser: throws on a non-zero exit, including stderr", async () => {
  const { runner } = fakeRunner({ code: 1, stdout: "", stderr: "boom" });
  await assert.rejects(() => upsertSuperuser("/hub/bin/pocketbase", "/hub/pb_data", "owner@example.test", "s3cret", runner), /boom/);
});

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function fakeFetch(handler: (call: FetchCall) => Response): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function authOkResponse(): Response {
  return new Response(JSON.stringify({ token: "tok-123" }), { status: 200, headers: { "content-type": "application/json" } });
}

test("createUser: authenticates as the superuser, then creates the user when absent", async () => {
  const { fetch: doFetch, calls } = fakeFetch((call) => {
    if (call.url.includes("_superusers/auth-with-password")) return authOkResponse();
    if (call.url.includes("users/records?filter")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (call.url.includes("users/records") && call.init?.method === "POST") return new Response(JSON.stringify({ id: "u1" }), { status: 200 });
    throw new Error(`unexpected call: ${call.url}`);
  });

  const result = await createUser("http://127.0.0.1:8090", { email: "owner@example.test", password: "s3cret" }, { email: "sync@example.test", password: "p4ss", role: "service" }, doFetch);

  assert.deepEqual(result, { outcome: "created" });
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url, "http://127.0.0.1:8090/api/collections/_superusers/auth-with-password");
  const authBody = JSON.parse(calls[0]!.init!.body as string);
  assert.deepEqual(authBody, { identity: "owner@example.test", password: "s3cret" });

  const createCall = calls[2]!;
  assert.equal(createCall.init?.method, "POST");
  const createBody = JSON.parse(createCall.init!.body as string);
  assert.equal(createBody.email, "sync@example.test");
  assert.equal(createBody.password, "p4ss");
  assert.equal(createBody.passwordConfirm, "p4ss");
  assert.equal(createBody.role, "service");
  assert.equal(createBody.emailVisibility, true);
  assert.equal(createBody.verified, true);
});

test("createUser: idempotent — returns 'exists' and does not POST when the user is already there", async () => {
  const { fetch: doFetch, calls } = fakeFetch((call) => {
    if (call.url.includes("_superusers/auth-with-password")) return authOkResponse();
    if (call.url.includes("users/records?filter")) return new Response(JSON.stringify({ items: [{ id: "u1" }] }), { status: 200 });
    throw new Error(`unexpected call: ${call.url}`);
  });

  const result = await createUser("http://127.0.0.1:8090", { email: "owner@example.test", password: "s3cret" }, { email: "sync@example.test", password: "p4ss", role: "service" }, doFetch);

  assert.deepEqual(result, { outcome: "exists" });
  assert.equal(calls.length, 2);
});

test("createUser: throws when superuser authentication fails", async () => {
  const { fetch: doFetch } = fakeFetch(() => new Response(null, { status: 401 }));
  await assert.rejects(
    () => createUser("http://127.0.0.1:8090", { email: "owner@example.test", password: "wrong" }, { email: "sync@example.test", password: "p4ss", role: "service" }, doFetch),
    /authentication/,
  );
});

test("createUser: the lookup filter is URL-encoded and scoped to the user's email", async () => {
  const { fetch: doFetch, calls } = fakeFetch((call) => {
    if (call.url.includes("_superusers/auth-with-password")) return authOkResponse();
    if (call.url.includes("users/records?filter")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    return new Response(JSON.stringify({ id: "u1" }), { status: 200 });
  });

  await createUser("http://127.0.0.1:8090", { email: "owner@example.test", password: "s3cret" }, { email: "a+b@example.test", password: "p4ss", role: "owner" }, doFetch);

  const lookupCall = calls[1]!;
  assert.equal(lookupCall.url, `http://127.0.0.1:8090/api/collections/users/records?filter=${encodeURIComponent('email="a+b@example.test"')}`);
});
