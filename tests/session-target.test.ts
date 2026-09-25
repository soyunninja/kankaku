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
  tasks: [
    { id: "t-open", title: "Fix the thing", projectId: "p-portal", status: "open" },
    { id: "t-done", title: "Old and done", projectId: "p-portal", status: "done" },
  ],
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

/** A `Catalog` whose `refresh` never resolves on its own — only when the given `AbortSignal` fires — for deterministically testing the overall first-fetch deadline without real timers. */
class HangingCatalog implements Catalog {
  read(): CatalogSnapshot | undefined {
    return undefined;
  }
  isStale(): boolean {
    return true;
  }
  refresh(signal?: AbortSignal): Promise<CatalogSnapshot | undefined> {
    return new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve(undefined));
    });
  }
}

/**
 * A `Catalog` that already has a cached snapshot but whose `refresh` never
 * settles on its own (no `AbortSignal` handling at all) — for
 * deterministically testing the picker-refresh deadline race: the returned
 * promise is never aborted, so a later manual `resolveRefresh` still lands.
 */
class StaleCatalogThatNeverRefreshes implements Catalog {
  refreshCalls = 0;
  resolveRefresh: ((snapshot: CatalogSnapshot | undefined) => void) | undefined;
  snapshot: CatalogSnapshot;

  constructor(snapshot: CatalogSnapshot) {
    this.snapshot = snapshot;
  }

  read(): CatalogSnapshot | undefined {
    return this.snapshot;
  }
  isStale(): boolean {
    return true;
  }
  refresh(): Promise<CatalogSnapshot | undefined> {
    this.refreshCalls += 1;
    return new Promise((resolve) => {
      this.resolveRefresh = (fresh) => {
        if (fresh) this.snapshot = fresh;
        resolve(fresh);
      };
    });
  }
}

/** A fake `setTimeout`/`clearTimeout` pair that never fires on its own; the test invokes the captured handler(s) itself — mirrors `status-bar.test.ts`'s fake interval scheduler. */
function makeFakeTimer() {
  const scheduled: Array<{ handler: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  return {
    scheduled,
    cleared,
    setTimeout: (handler: () => void, ms: number): NodeJS.Timeout => {
      scheduled.push({ handler, ms });
      return scheduled.length as unknown as NodeJS.Timeout;
    },
    clearTimeout: (handle: NodeJS.Timeout) => {
      cleared.push(handle);
    },
    fireAll: () => {
      for (const entry of scheduled) entry.handler();
    },
  };
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

test("the very first (no-cache) fetch is bounded by an overall deadline: when it fires, ensurePicked behaves exactly like hub-unreachable", async () => {
  const timer = makeFakeTimer();
  const target = createSessionTarget(makeDeps({ catalog: new HangingCatalog(), setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout }));
  const { ctx, notified, selectCalls } = makeCtx(true, []);

  const promise = target.ensurePicked(makeFakePi(), ctx);
  timer.fireAll(); // simulate the deadline elapsing, no real wait
  await promise;

  assert.equal(selectCalls.length, 0);
  assert.equal(notified.length, 1);
  assert.match(notified[0]?.[0] ?? "", /hub unreachable/);
});

test("the first-fetch deadline defaults to 5000ms", async () => {
  const timer = makeFakeTimer();
  const target = createSessionTarget(makeDeps({ catalog: new HangingCatalog(), setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout }));
  const { ctx } = makeCtx(true, []);

  const promise = target.ensurePicked(makeFakePi(), ctx);
  assert.equal(timer.scheduled[0]?.ms, 5000);
  timer.fireAll();
  await promise;
});

test("the first-fetch deadline is injectable via firstFetchDeadlineMs", async () => {
  const timer = makeFakeTimer();
  const target = createSessionTarget(
    makeDeps({ catalog: new HangingCatalog(), firstFetchDeadlineMs: 1234, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout }),
  );
  const { ctx } = makeCtx(true, []);

  const promise = target.ensurePicked(makeFakePi(), ctx);
  assert.equal(timer.scheduled[0]?.ms, 1234);
  timer.fireAll();
  await promise;
});

test("the deadline timer is cleared once the first fetch resolves normally, before the deadline fires", async () => {
  const timer = makeFakeTimer();
  const catalog = new FakeCatalog();
  catalog.refreshResult = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout }));
  const { ctx } = makeCtx(true, ["Acme", "(no project)"]);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(timer.cleared.length, 1);
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

test("ensurePicked resolves silently from the cache immediately and does not await the background refresh it started", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  let resolveRefresh: (() => void) | undefined;
  catalog.refresh = () => {
    catalog.refreshCalls += 1;
    return new Promise((resolve) => {
      resolveRefresh = () => resolve(SNAPSHOT);
    });
  };
  const target = createSessionTarget(makeDeps({ catalog, resolveProjectConfigIds: () => ({ clientId: "c-acme" }) }));
  const { ctx } = makeCtx(true, []);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(target.effectiveTarget()?.clientId, "c-acme", "resolved immediately from the cache");
  assert.ok(resolveRefresh, "a background refresh was started");
  assert.equal(catalog.refreshCalls, 1);
  resolveRefresh?.();
});

test("with a fresh (non-stale) cache, ensurePicked still starts a refresh", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  catalog.stale = false;
  const target = createSessionTarget(makeDeps({ catalog, resolveProjectConfigIds: () => ({ clientId: "c-acme" }) }));
  const { ctx } = makeCtx(true, []);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(catalog.refreshCalls, 1);
});

test("ensurePicked shows the picker with the freshly refreshed snapshot when refresh resolves before the picker deadline", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  let resolveRefresh: ((snapshot: CatalogSnapshot | undefined) => void) | undefined;
  catalog.refresh = () =>
    new Promise((resolve) => {
      resolveRefresh = (fresh) => {
        if (fresh) catalog.snapshot = fresh;
        resolve(fresh);
      };
    });
  const FRESH: CatalogSnapshot = {
    ...SNAPSHOT,
    clients: [...SNAPSHOT.clients, { id: "c-initech", name: "Initech", code: "initech", active: true }],
  };
  const target = createSessionTarget(makeDeps({ catalog }));
  const { ctx, selectCalls } = makeCtx(true, ["Initech", "(no project)"]);

  const promise = target.ensurePicked(makeFakePi(), ctx);
  resolveRefresh?.(FRESH);
  await promise;

  assert.ok(selectCalls[0]?.options.includes("Initech"), "the picker was offered the client from the fresh snapshot");
  assert.equal(target.effectiveTarget()?.clientId, "c-initech");
});

test("ensurePicked shows the picker with the cached snapshot when refresh has not resolved at the picker deadline, and the refresh is not aborted", async () => {
  const catalog = new StaleCatalogThatNeverRefreshes(SNAPSHOT);
  const timer = makeFakeTimer();
  const target = createSessionTarget(makeDeps({ catalog, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout }));
  const { ctx, selectCalls } = makeCtx(true, ["Acme", "Portal"]);

  const promise = target.ensurePicked(makeFakePi(), ctx);
  timer.fireAll(); // simulate the picker-refresh deadline elapsing; the refresh keeps running
  await promise;

  assert.ok(!selectCalls[0]?.options.includes("Initech"));
  assert.equal(target.effectiveTarget()?.clientId, "c-acme", "the picker used the cached snapshot");
  assert.equal(catalog.refreshCalls, 1);

  const FRESH: CatalogSnapshot = {
    ...SNAPSHOT,
    clients: [...SNAPSHOT.clients, { id: "c-initech", name: "Initech", code: "initech", active: true }],
  };
  catalog.resolveRefresh?.(FRESH);
  assert.equal(catalog.read()?.clients.some((c) => c.id === "c-initech"), true, "the background refresh, once it resolves, still updates the catalog");
});

test("ensurePicked shows the picker with the cached snapshot when the background refresh fails, with no notification", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  catalog.refreshResult = undefined;
  const target = createSessionTarget(makeDeps({ catalog }));
  const { ctx, notified, selectCalls } = makeCtx(true, ["Acme", "Portal"]);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(selectCalls.length, 2);
  assert.equal(target.effectiveTarget()?.clientId, "c-acme");
  assert.equal(notified.length, 0, "a failed background refresh falls back to the cache silently");
});

test("ensurePicked resolves silently from the project config and returns before a never-resolving background refresh settles", async () => {
  const catalog = new StaleCatalogThatNeverRefreshes(SNAPSHOT);
  const target = createSessionTarget(makeDeps({ catalog, resolveProjectConfigIds: () => ({ clientId: "c-acme" }) }));
  const { ctx, selectCalls } = makeCtx(true, []);

  await target.ensurePicked(makeFakePi(), ctx);

  assert.equal(selectCalls.length, 0);
  assert.equal(target.effectiveTarget()?.clientId, "c-acme");
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

test("pick awaits the background refresh up to the picker deadline and falls back to the cache", async () => {
  const catalog = new StaleCatalogThatNeverRefreshes(SNAPSHOT);
  const timer = makeFakeTimer();
  const target = createSessionTarget(makeDeps({ catalog, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout }));
  const pi = makeFakePi();
  const { ctx, selectCalls } = makeCtx(true, ["Acme", "Portal"]);

  const promise = target.pick(pi, ctx);
  timer.fireAll();
  await promise;

  assert.equal(selectCalls.length, 2);
  assert.equal(target.effectiveTarget()?.clientId, "c-acme");
  assert.equal(catalog.refreshCalls, 1);
});

test("the picker-refresh deadline defaults to 1500ms", async () => {
  const catalog = new StaleCatalogThatNeverRefreshes(SNAPSHOT);
  const timer = makeFakeTimer();
  const target = createSessionTarget(makeDeps({ catalog, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout }));
  const { ctx } = makeCtx(true, ["Acme", "Portal"]);

  const promise = target.pick(makeFakePi(), ctx);
  assert.equal(timer.scheduled[0]?.ms, 1500);
  timer.fireAll();
  await promise;
});

test("the picker-refresh deadline is injectable via pickerRefreshDeadlineMs", async () => {
  const catalog = new StaleCatalogThatNeverRefreshes(SNAPSHOT);
  const timer = makeFakeTimer();
  const target = createSessionTarget(
    makeDeps({ catalog, pickerRefreshDeadlineMs: 750, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout }),
  );
  const { ctx } = makeCtx(true, ["Acme", "Portal"]);

  const promise = target.pick(makeFakePi(), ctx);
  assert.equal(timer.scheduled[0]?.ms, 750);
  timer.fireAll();
  await promise;
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

// --- hub task linking (pickTask/clearTask) ---

test("effectiveTarget resolves hubTaskId/hubTaskTitle from the catalog when the session override carries one", () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();

  target.setExplicit(pi, { clientId: "c-acme", projectId: "p-portal" });
  // setExplicit never carries a hubTaskId; simulate a restored session entry that does.
  target.restore(makeCtxWithEntries([{ type: "custom", customType: TARGET_ENTRY_TYPE, data: { clientId: "c-acme", projectId: "p-portal", hubTaskId: "t-open" } }]));

  assert.equal(target.effectiveTarget()?.hubTaskId, "t-open");
  assert.equal(target.effectiveTarget()?.hubTaskTitle, "Fix the thing");
});

test("pickTask is a no-op for a subagent", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ role: "subagent", catalog }));
  const pi = makeFakePi();
  const { ctx, selectCalls, notified } = makeCtx(true, []);

  await target.pickTask(pi, ctx);

  assert.equal(selectCalls.length, 0);
  assert.equal(notified.length, 0);
  assert.equal(pi.appended.length, 0);
});

test("pickTask is a no-op without a UI", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();
  const { ctx, selectCalls } = makeCtx(false, []);

  await target.pickTask(pi, ctx);

  assert.equal(selectCalls.length, 0);
});

test("pickTask notifies to pick a client/project first when nothing is effective yet", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();
  const { ctx, notified, selectCalls } = makeCtx(true, []);

  await target.pickTask(pi, ctx);

  assert.equal(selectCalls.length, 0);
  assert.equal(notified.some(([message]) => message.includes("Pick a client and project first")), true);
});

test("pickTask notifies to pick a client/project first when a target resolves but has no project", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();
  target.setExplicit(pi, { clientId: "c-acme" });
  const { ctx, notified, selectCalls } = makeCtx(true, []);

  await target.pickTask(pi, ctx);

  assert.equal(selectCalls.length, 0);
  assert.equal(notified.some(([message]) => message.includes("Pick a client and project first")), true);
});

test("pickTask notifies 'no open tasks' when the effective project has none", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = { ...SNAPSHOT, tasks: [] };
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();
  target.setExplicit(pi, { clientId: "c-acme", projectId: "p-portal" });
  const { ctx, notified, selectCalls } = makeCtx(true, []);

  await target.pickTask(pi, ctx);

  assert.equal(selectCalls.length, 0);
  assert.equal(notified.some(([message]) => message.includes("No open tasks")), true);
});

test("pickTask sets the session override with hubTaskId, appends the session entry, and notifies the new label", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();
  target.setExplicit(pi, { clientId: "c-acme", projectId: "p-portal" });
  const { ctx, notified } = makeCtx(true, ["Fix the thing"]);

  await target.pickTask(pi, ctx);

  assert.equal(target.effectiveTarget()?.hubTaskId, "t-open");
  assert.deepEqual(pi.appended.at(-1), {
    customType: TARGET_ENTRY_TYPE,
    data: { clientId: "c-acme", projectId: "p-portal", hubTaskId: "t-open" },
  });
  assert.equal(notified.some(([message]) => message.includes("Fix the thing")), true);
});

test("pickTask never persists to the project config file (task linking is session-only)", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  let persisted = false;
  const target = createSessionTarget(makeDeps({ catalog, persistProjectConfig: () => { persisted = true; } }));
  const pi = makeFakePi();
  target.setExplicit(pi, { clientId: "c-acme", projectId: "p-portal" });
  const { ctx } = makeCtx(true, ["Fix the thing"]);

  await target.pickTask(pi, ctx);

  assert.equal(persisted, false);
});

test("pickTask does nothing when the user skips the task picker", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();
  target.setExplicit(pi, { clientId: "c-acme", projectId: "p-portal" });
  const appendedBefore = pi.appended.length;
  const { ctx } = makeCtx(true, ["— skip —"]);

  await target.pickTask(pi, ctx);

  assert.equal(pi.appended.length, appendedBefore);
  assert.equal(target.effectiveTarget()?.hubTaskId, undefined);
});

test("clearTask does nothing when the session override has no hubTaskId", () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();
  target.setExplicit(pi, { clientId: "c-acme", projectId: "p-portal" });
  const appendedBefore = pi.appended.length;

  target.clearTask(pi);

  assert.equal(pi.appended.length, appendedBefore);
});

test("clearTask drops hubTaskId from the session override, keeping client/project, and appends the entry", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();
  target.setExplicit(pi, { clientId: "c-acme", projectId: "p-portal" });
  const { ctx } = makeCtx(true, ["Fix the thing"]);
  await target.pickTask(pi, ctx);
  assert.equal(target.effectiveTarget()?.hubTaskId, "t-open");

  target.clearTask(pi);

  assert.equal(target.effectiveTarget()?.hubTaskId, undefined);
  assert.equal(target.effectiveTarget()?.projectId, "p-portal");
  assert.deepEqual(pi.appended.at(-1), { customType: TARGET_ENTRY_TYPE, data: { clientId: "c-acme", projectId: "p-portal" } });
});

test("setExplicit never carries a hubTaskId forward, even after a previous pickTask (a target change drops the task)", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const target = createSessionTarget(makeDeps({ catalog }));
  const pi = makeFakePi();
  target.setExplicit(pi, { clientId: "c-acme", projectId: "p-portal" });
  const { ctx } = makeCtx(true, ["Fix the thing"]);
  await target.pickTask(pi, ctx);
  assert.equal(target.effectiveTarget()?.hubTaskId, "t-open");

  target.setExplicit(pi, { clientId: "c-globex" });

  assert.equal(target.effectiveTarget()?.hubTaskId, undefined);
  assert.deepEqual(pi.appended.at(-1), { customType: TARGET_ENTRY_TYPE, data: { clientId: "c-globex" } });
});

test("pick (the target picker) never carries a hubTaskId forward either, and never persists one to the project config file", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  let remembered: unknown;
  const target = createSessionTarget(makeDeps({ catalog, persistProjectConfig: (ids) => { remembered = ids; } }));
  const pi = makeFakePi();
  target.setExplicit(pi, { clientId: "c-acme", projectId: "p-portal" });
  const { ctx: pickCtx } = makeCtx(true, ["Fix the thing"]);
  await target.pickTask(pi, pickCtx);
  assert.equal(target.effectiveTarget()?.hubTaskId, "t-open");

  const { ctx: retargetCtx } = makeCtx(true, ["Acme", "Portal"], true);
  await target.pick(pi, retargetCtx);

  assert.equal(target.effectiveTarget()?.hubTaskId, undefined);
  assert.equal(remembered !== undefined && remembered !== null && typeof remembered === "object" && "hubTaskId" in remembered, false);
});
