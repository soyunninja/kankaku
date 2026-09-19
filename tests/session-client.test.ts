import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionClient, CLIENT_ENTRY_TYPE } from "../src/adapters/session-client.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function makeCtx(entries: Array<{ type: string; customType?: string; data?: unknown }>): ExtensionContext {
  return {
    sessionManager: { getEntries: () => entries },
  } as unknown as ExtensionContext;
}

function makeFakePi(): ExtensionAPI & { appended: Array<{ customType: string; data: unknown }> } {
  const appended: Array<{ customType: string; data: unknown }> = [];
  return {
    appended,
    appendEntry: (customType: string, data?: unknown) => appended.push({ customType, data }),
  } as unknown as ExtensionAPI & { appended: Array<{ customType: string; data: unknown }> };
}

test("restore sets the session client from the last kankaku-client entry, taking the most recent one", () => {
  const client = createSessionClient({ role: "orchestrator" });
  const ctx = makeCtx([
    { type: "custom", customType: CLIENT_ENTRY_TYPE, data: { client: "old" } },
    { type: "message", data: {} },
    { type: "custom", customType: CLIENT_ENTRY_TYPE, data: { client: "new" } },
  ]);

  client.restore(ctx);

  assert.equal(client.effectiveClient(), "new");
});

test("restore leaves the session client undefined when no kankaku-client entry exists", () => {
  const client = createSessionClient({ role: "orchestrator", envClient: "acme" });
  client.restore(makeCtx([]));

  assert.equal(client.effectiveSource(), "env");
});

test("set updates the session client and persists it as a kankaku-client custom entry", () => {
  const client = createSessionClient({ role: "orchestrator" });
  const pi = makeFakePi();

  client.set(pi, "acme");

  assert.equal(client.effectiveClient(), "acme");
  assert.deepEqual(pi.appended, [{ customType: CLIENT_ENTRY_TYPE, data: { client: "acme" } }]);

  client.set(pi, undefined);
  assert.equal(client.effectiveClient(), undefined);
  assert.deepEqual(pi.appended[1], { customType: CLIENT_ENTRY_TYPE, data: { client: undefined } });
});

test("effectiveClient and effectiveSource follow session > env > project precedence regardless of role", () => {
  const client = createSessionClient({ role: "subagent", envClient: "globex", resolveProjectClient: () => "initech" });

  assert.equal(client.effectiveClient(), "globex");
  assert.equal(client.effectiveSource(), "env");
});

test("runClient resolves only for the orchestrator role, and caches the project client for the run", () => {
  let reads = 0;
  const orchestrator = createSessionClient({
    role: "orchestrator",
    resolveProjectClient: () => {
      reads += 1;
      return "initech";
    },
  });

  assert.equal(orchestrator.runClient(), "initech");
  assert.equal(orchestrator.runClient(), "initech");
  assert.equal(reads, 1, "the project client is read once per run");

  orchestrator.endRun();
  assert.equal(orchestrator.runClient(), "initech");
  assert.equal(reads, 2, "endRun drops the cache so the next run reads again");

  const subagent = createSessionClient({ role: "subagent", resolveProjectClient: () => "initech" });
  assert.equal(subagent.runClient(), undefined);
});

test("idleClient reuses the run's cached project client while it is still held", () => {
  let reads = 0;
  const client = createSessionClient({
    role: "orchestrator",
    resolveProjectClient: () => {
      reads += 1;
      return "initech";
    },
  });

  client.runClient();
  assert.equal(reads, 1);

  assert.equal(client.idleClient(), "initech");
  assert.equal(reads, 1, "idleClient must not re-read the project client while the run's cache is held");

  client.endRun();
  assert.equal(client.idleClient(), "initech");
  assert.equal(reads, 2, "after endRun, idleClient reads the project client fresh");
});
