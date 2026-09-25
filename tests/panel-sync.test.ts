import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createSyncScreen } from "../src/adapters/panel/screens/sync.ts";
import type { SyncCommandDeps } from "../src/adapters/kankaku-command.ts";
import type { SyncSummary } from "../src/adapters/sync-runner.ts";
import type { SyncState } from "../src/domain/sync-plan.ts";
import type { Catalog, CatalogSnapshot } from "../src/ports/catalog.ts";
import { DOWN, ENTER, ESCAPE, fakeHost } from "./helpers/panel-fakes.ts";

type TestComponent = Component & { handleInput: NonNullable<Component["handleInput"]> };

function emptySyncSummary(overrides: Partial<SyncSummary> = {}): SyncSummary {
  return { uploaded: 0, updated: 0, skipped: 0, failed: [], unassigned: {}, syncedThrough: undefined, durationMs: 1, ...overrides };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeCtx(): ExtensionContext {
  return { hasUI: true } as unknown as ExtensionContext;
}

/** A `SyncCommandDeps` double: `run()` is deferred (controlled by `resolveNextRun`) so a test can observe the busy line before it settles. */
class FakeSync implements SyncCommandDeps {
  runCalls: Array<{ full?: boolean } | undefined> = [];
  statusResult: { state: SyncState | undefined; pending: number; staleOutsideWindow: number } = { state: undefined, pending: 0, staleOutsideWindow: 0 };
  private nextResolve: ((summary: SyncSummary) => void) | undefined;

  run(options?: { full?: boolean }): Promise<SyncSummary> {
    this.runCalls.push(options);
    return new Promise((resolve) => {
      this.nextResolve = resolve;
    });
  }

  status() {
    return this.statusResult;
  }

  resolveRun(summary: SyncSummary): void {
    this.nextResolve?.(summary);
  }
}

const SNAPSHOT: CatalogSnapshot = {
  fetchedAt: 0,
  url: "https://pb.example.com",
  clients: [
    { id: "c-acme", name: "Acme", code: "acme", active: true },
    { id: "c-globex", name: "Globex", code: "globex", active: true },
  ],
  projects: [{ id: "p-portal", name: "Portal", clientId: "c-acme", repoPaths: [], active: true }],
};

class FakeCatalog implements Catalog {
  refreshResult: CatalogSnapshot | undefined = SNAPSHOT;
  read(): CatalogSnapshot | undefined {
    return SNAPSHOT;
  }
  isStale(): boolean {
    return false;
  }
  refresh(): Promise<CatalogSnapshot | undefined> {
    return Promise.resolve(this.refreshResult);
  }
}

test("renders the sync status body from buildSyncStatusLines", () => {
  const sync = new FakeSync();
  sync.statusResult = { state: { target: "https://pb.example.com", syncedThrough: "2026-09-20T00:00:00.000Z", hashes: {} }, pending: 4, staleOutsideWindow: 0 };

  const factory = createSyncScreen({ sync, ctx: makeCtx(), refreshIdleStatus: () => {}, pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  const lines = component.render(100).join("\n");
  assert.match(lines, /synced through 2026-09-20T00:00:00\.000Z/);
  assert.match(lines, /pending: 4/);
});

test("'sync now' shows a busy line, then the result, calling run({}) and refreshing idle status", async () => {
  const sync = new FakeSync();
  let refreshed = 0;
  const factory = createSyncScreen({ sync, ctx: makeCtx(), refreshIdleStatus: () => refreshed++, pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(ENTER); // "sync-now" is the topmost row
  assert.match(component.render(100).join("\n"), /…/);

  sync.resolveRun(emptySyncSummary({ uploaded: 2, updated: 1, skipped: 3 }));
  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(sync.runCalls, [{}]);
  assert.match(component.render(100).join("\n"), /uploaded 2, updated 1, skipped 3, failed 0/);
  assert.equal(refreshed, 1);
});

test("'sync all' runs a full sync (run({ full: true })) and reports the summary", async () => {
  const sync = new FakeSync();
  const factory = createSyncScreen({ sync, ctx: makeCtx(), refreshIdleStatus: () => {}, pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(DOWN); // sync-now -> sync-all
  component.handleInput(ENTER);
  sync.resolveRun(emptySyncSummary({ uploaded: 5 }));
  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(sync.runCalls, [{ full: true }]);
  assert.match(component.render(100).join("\n"), /uploaded 5/);
});

test("'backfill' runs a full sync (run({ full: true })) and reports the unassigned breakdown", async () => {
  const sync = new FakeSync();
  const factory = createSyncScreen({ sync, ctx: makeCtx(), refreshIdleStatus: () => {}, pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(DOWN); // sync-now -> sync-all
  component.handleInput(DOWN); // sync-all -> backfill
  component.handleInput(ENTER);
  sync.resolveRun(emptySyncSummary({ unassigned: { cajamar: 2 } }));
  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(sync.runCalls, [{ full: true }]);
  assert.match(component.render(100).join("\n"), /cajamar: 2 task\(s\) -> Sin determinar/);
});

test("'refresh catalog' calls catalog.refresh() and reports client/project counts", async () => {
  const sync = new FakeSync();
  const catalog = new FakeCatalog();
  const factory = createSyncScreen({ sync, catalog, ctx: makeCtx(), refreshIdleStatus: () => {}, pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(DOWN); // sync-now -> sync-all
  component.handleInput(DOWN); // sync-all -> backfill
  component.handleInput(DOWN); // backfill -> catalog-refresh
  component.handleInput(ENTER);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.match(component.render(100).join("\n"), /2 client\(s\), 1 project\(s\)/);
});

test("the 'refresh catalog' row is omitted entirely when no catalog is configured", () => {
  const sync = new FakeSync();
  const factory = createSyncScreen({ sync, ctx: makeCtx(), refreshIdleStatus: () => {}, pinReport: () => {} });
  const component = factory(fakeHost()) as TestComponent;

  const lines = component.render(100).join("\n");
  assert.doesNotMatch(lines, /Refresh catalog/);
});

test("'pin' pins the current sync status lines under the title 'sync status'", async () => {
  const sync = new FakeSync();
  sync.statusResult = { state: undefined, pending: 7, staleOutsideWindow: 0 };
  const pinned: Array<{ title: string; lines: string[] }> = [];
  const factory = createSyncScreen({ sync, ctx: makeCtx(), refreshIdleStatus: () => {}, pinReport: (report) => pinned.push(report) });
  const component = factory(fakeHost()) as TestComponent;

  component.handleInput(DOWN); // sync-now -> sync-all
  component.handleInput(DOWN); // sync-all -> backfill
  component.handleInput(DOWN); // backfill -> pin
  component.handleInput(ENTER);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(pinned.length, 1);
  assert.equal(pinned[0]!.title, "sync status");
  assert.match(pinned[0]!.lines.join("\n"), /pending: 7/);
});

test("escape from the sync screen's list goes back", () => {
  const sync = new FakeSync();
  const factory = createSyncScreen({ sync, ctx: makeCtx(), refreshIdleStatus: () => {}, pinReport: () => {} });
  const host = fakeHost();
  const component = factory(host) as TestComponent;

  component.handleInput(ESCAPE);
  assert.equal(host.backCalls, 1);
});
