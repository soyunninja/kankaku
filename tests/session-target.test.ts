import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionTarget, TARGET_ENTRY_TYPE } from "../src/adapters/session-target.ts";
import type { SessionTargetDeps } from "../src/adapters/session-target.ts";
import type { Catalog, CatalogSnapshot } from "../src/ports/catalog.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SNAPSHOT: CatalogSnapshot = {
  fetchedAt: 0,
  url: "https://pb.example.com",
  clients: [
    { id: "c-acme", name: "Acme", code: "acme", active: true },
    { id: "c-globex", name: "Globex", code: "globex", active: true },
  ],
  projects: [{ id: "p-portal", name: "Portal", clientId: "c-acme", repoPaths: ["/repos/portal"], active: true }],
};

class FakeCatalog implements Catalog {
  snapshot: CatalogSnapshot | undefined;
  stale = false;
  refreshResult: CatalogSnapshot | undefined;
  refreshCalls = 0;

  read(): CatalogSnapshot | undefined {
    return this.snapshot;
  }
  isStale(): boolean {
    return this.stale;
  }
  async refresh(): Promise<CatalogSnapshot | undefined> {
    this.refreshCalls += 1;
    if (this.refreshResult) this.snapshot = this.refreshResult;
    return this.refreshResult;
  }
}

function makeCtx(hasUI: boolean, selectResponses: Array<string | undefined>, confirmResponse = true) {
  const notified: Array<[string, string?]> = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  let selectIndex = 0;
  const ctx = {
    hasUI,
    sessionManager: { getEntries: () => [] as Array<{ type: string; customType?: string; data?: unknown }> },
    ui: {
      select: async (title: string, options: string[]) => {
        selectCalls.push({ title, options });
        return selectResponses[selectIndex++];
      },
      confirm: async () => confirmResponse,
      notify: (message: string, type?: string) => notified.push([message, type]),
    },
  } as unknown as ExtensionContext;
  return { ctx, notified, selectCalls };
}

function makeCtxWithEntries(entries: Array<{ type: string; customType?: string; data?: unknown }>): ExtensionContext {
  return { sessionManager: { getEntries: () => entries } } as unknown as ExtensionContext;
}

function makeFakePi(): ExtensionAPI & { appended: Array<{ customType: string; data: unknown }> } {
  const appended: Array<{ customType: string; data: unknown }> = [];
  return {
    appended,
    appendEntry: (customType: string, data?: unknown) => appended.push({ customType, data }),
  } as unknown as ExtensionAPI & { appended: Array<{ customType: string; data: unknown }> };
}

function makeDeps(overrides: Partial<SessionTargetDeps> = {}): SessionTargetDeps {
  return {
    role: "orchestrator",
    catalog: new FakeCatalog(),
    resolveProjectConfigIds: () => undefined,
    persistProjectConfig: () => {},
    cwd: () => "/nowhere",
    ...overrides,
  };
}

test("restore leaves the override undefined when no kankaku-target entry exists", () => {
  const target = createSessionTarget(makeDeps());
  target.restore(makeCtxWithEntries([]));

  assert.equal(target.effectiveTarget(), undefined);
});

test("restore sets an explicit target from the last kankaku-target entry", () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  target.restore(
    makeCtxWithEntries([
      { type: "custom", customType: TARGET_ENTRY_TYPE, data: { clientId: "c-acme" } },
      { type: "custom", customType: TARGET_ENTRY_TYPE, data: { clientId: "c-globex" } },
    ]),
  );

  assert.equal(target.effectiveTarget()?.clientId, "c-globex");
  assert.equal(target.effectiveSource(), "session");
});

test("restore sets a skipped override that resolves to no target", () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog, resolveProjectConfigIds: () => ({ clientId: "c-acme" }) }));
  target.restore(makeCtxWithEntries([{ type: "custom", customType: TARGET_ENTRY_TYPE, data: { skipped: true } }]));

  assert.equal(target.effectiveTarget(), undefined);
});

test("ensurePicked is a no-op for a subagent", async () => {
  const catalog = new FakeCatalog();
  const target = createSessionTarget(makeDeps({ role: "subagent", catalog }));
  const { ctx } = makeCtx(true, []);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(catalog.refreshCalls, 0);
});

test("ensurePicked is a no-op without a UI", async () => {
  const catalog = new FakeCatalog();
  const target = createSessionTarget(makeDeps({ catalog }));
  const { ctx } = makeCtx(false, []);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(catalog.refreshCalls, 0);
});

test("ensurePicked does not ask again once a session override was restored", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  target.restore(makeCtxWithEntries([{ type: "custom", customType: TARGET_ENTRY_TYPE, data: { skipped: true } }]));
  const { ctx, selectCalls } = makeCtx(true, []);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(selectCalls.length, 0);
});

test("ensurePicked resolves silently from the project config file and does not show the picker", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog, resolveProjectConfigIds: () => ({ clientId: "c-acme" }) }));
  const { ctx, selectCalls } = makeCtx(true, []);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(selectCalls.length, 0);
  assert.equal(target.effectiveTarget()?.clientId, "c-acme");
});

test("ensurePicked resolves silently from repoPaths and does not show the picker", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog, cwd: () => "/repos/portal" }));
  const { ctx, selectCalls } = makeCtx(true, []);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(selectCalls.length, 0);
  assert.equal(target.effectiveTarget()?.projectId, "p-portal");
});

test("ensurePicked shows the picker when nothing resolves, persists the pick as a session entry, and offers to remember it", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  let remembered: unknown;
  const target = createSessionTarget(
    makeDeps({ catalog, persistProjectConfig: (ids) => { remembered = ids; } }),
  );
  const pi = makeFakePi();
  const { ctx } = makeCtx(true, ["Acme", "Portal"], true);

  await target.ensurePicked(pi, ctx);

  assert.equal(target.effectiveTarget()?.clientId, "c-acme");
  assert.equal(target.effectiveTarget()?.projectId, "p-portal");
  assert.deepEqual(pi.appended[0], { customType: TARGET_ENTRY_TYPE, data: { clientId: "c-acme", projectId: "p-portal" } });
  assert.deepEqual(remembered, { clientId: "c-acme", projectId: "p-portal" });
});

test("ensurePicked does not persist to the project config file when the user declines to remember", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  let persisted = false;
  const target = createSessionTarget(makeDeps({ catalog, persistProjectConfig: () => { persisted = true; } }));
  const pi = makeFakePi();
  const { ctx } = makeCtx(true, ["Acme", "(no project)"], false);

  await target.ensurePicked(pi, ctx);

  assert.equal(persisted, false);
});

test("ensurePicked persists a skip as a session entry and resolves to no target", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();
  const { ctx } = makeCtx(true, ["— skip —"]);

  await target.ensurePicked(pi, ctx);

  assert.equal(target.effectiveTarget(), undefined);
  assert.deepEqual(pi.appended[0], { customType: TARGET_ENTRY_TYPE, data: { skipped: true } });
});

test("ensurePicked notifies once when there is no cache and the hub is unreachable, and does not show the picker", async () => {
  const catalog = new FakeCatalog();
  catalog.refreshResult = undefined;
  const target = createSessionTarget(makeDeps({ catalog }));
  const { ctx, notified, selectCalls } = makeCtx(true, []);

  await target.ensurePicked(makeFakePi(), ctx);
  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(selectCalls.length, 0);
  assert.equal(notified.length, 1);
  assert.match(notified[0]?.[0] ?? "", /hub unreachable/);
});

test("ensurePicked awaits refresh when there is no cache at all", async () => {
  const catalog = new FakeCatalog();
  catalog.refreshResult = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const { ctx } = makeCtx(true, ["Acme", "(no project)"]);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(catalog.refreshCalls, 1);
  assert.equal(target.effectiveTarget()?.clientId, "c-acme");
});

test("ensurePicked uses a stale cache immediately and fires a background refresh without awaiting it", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  catalog.stale = true;
  let resolveRefresh: (() => void) | undefined;
  catalog.refresh = () =>
    new Promise((resolve) => {
      resolveRefresh = () => resolve(SNAPSHOT);
    });
  const target = createSessionTarget(makeDeps({ catalog, resolveProjectConfigIds: () => ({ clientId: "c-acme" }) }));
  const { ctx } = makeCtx(true, []);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(target.effectiveTarget()?.clientId, "c-acme", "resolved immediately from the stale cache");
  assert.ok(resolveRefresh, "a background refresh was started");
  resolveRefresh?.();
});

test("pick always shows the picker even when a session override already exists", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  target.restore(makeCtxWithEntries([{ type: "custom", customType: TARGET_ENTRY_TYPE, data: { skipped: true } }]));
  const pi = makeFakePi();
  const { ctx, selectCalls } = makeCtx(true, ["Globex", "(no project)"]);

  await target.pick(pi, ctx);

  assert.equal(selectCalls.length, 2);
  assert.equal(target.effectiveTarget()?.clientId, "c-globex");
});

test("setExplicit sets the session override without showing the picker", () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();

  target.setExplicit(pi, { clientId: "c-acme" });

  assert.equal(target.effectiveTarget()?.clientId, "c-acme");
  assert.deepEqual(pi.appended[0], { customType: TARGET_ENTRY_TYPE, data: { clientId: "c-acme" } });
});

test("clear removes the session override, falling back to the project config source", () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog, resolveProjectConfigIds: () => ({ clientId: "c-globex" }) }));
  const pi = makeFakePi();

  target.setExplicit(pi, { clientId: "c-acme" });
  target.clear(pi);

  assert.equal(target.effectiveTarget()?.clientId, "c-globex");
  assert.deepEqual(pi.appended.at(-1), { customType: TARGET_ENTRY_TYPE, data: {} });
});

test("runTarget resolves only for the orchestrator role, and caches the project config read for the run", () => {
  let reads = 0;
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const orchestrator = createSessionTarget(
    makeDeps({
      catalog,
      resolveProjectConfigIds: () => {
        reads += 1;
        return { clientId: "c-acme" };
      },
    }),
  );

  assert.equal(orchestrator.runTarget()?.clientId, "c-acme");
  assert.equal(orchestrator.runTarget()?.clientId, "c-acme");
  assert.equal(reads, 1, "the project config is read once per run");

  orchestrator.endRun();
  assert.equal(orchestrator.runTarget()?.clientId, "c-acme");
  assert.equal(reads, 2, "endRun drops the cache so the next run reads again");

  const subagent = createSessionTarget(makeDeps({ role: "subagent", catalog, resolveProjectConfigIds: () => ({ clientId: "c-acme" }) }));
  assert.equal(subagent.runTarget(), undefined);
});

test("idleTarget reuses the run's cached project config read while one is held", () => {
  let reads = 0;
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(
    makeDeps({
      catalog,
      resolveProjectConfigIds: () => {
        reads += 1;
        return { clientId: "c-acme" };
      },
    }),
  );

  target.runTarget();
  assert.equal(target.idleTarget()?.clientId, "c-acme");
  assert.equal(reads, 1);
});
