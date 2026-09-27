import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalogModel } from "../src/domain/catalog-model.ts";
import type { CatalogSnapshot } from "kankaku/ports";

function snapshot(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    fetchedAt: 1_000_000,
    url: "https://pb.example.com",
    clients: [
      { id: "c1", name: "Acme", code: "acme", active: true },
      { id: "c2", name: "Inactive Co", code: "inactive", active: false },
    ],
    projects: [
      { id: "p1", name: "Website", clientId: "c1", repoPaths: [], active: true },
      { id: "p2", name: "Old project", clientId: "c1", repoPaths: [], active: false },
      { id: "p3", name: "Orphan", clientId: "c2", repoPaths: [], active: true },
    ],
    tasks: [
      { id: "t1", title: "Fix bug", projectId: "p1", status: "open" },
      { id: "t2", title: "Ship feature", projectId: "p1", status: "doing" },
      { id: "t3", title: "Done thing", projectId: "p1", status: "done" },
    ],
    ...overrides,
  };
}

test("buildCatalogModel reports 'unavailable' with no snapshot", () => {
  const model = buildCatalogModel(undefined, 2_000_000);
  assert.equal(model.status, "unavailable");
});

test("buildCatalogModel nests active projects under active clients, sorted by name, with open/doing counts", () => {
  const model = buildCatalogModel(snapshot(), 2_000_000);
  assert.equal(model.status, "ready");
  if (model.status !== "ready") return;

  assert.deepEqual(
    model.clients.map((c) => c.name),
    ["Acme"],
  );
  const acme = model.clients[0]!;
  assert.deepEqual(
    acme.projects.map((p) => p.name),
    ["Website"],
  );
  const website = acme.projects[0]!;
  assert.equal(website.openCount, 1);
  assert.equal(website.doingCount, 1);
});

test("buildCatalogModel computes age and flags stale past the TTL", () => {
  const fresh = buildCatalogModel(snapshot({ fetchedAt: 1_000_000 }), 1_000_000 + 60_000);
  assert.equal(fresh.status, "ready");
  if (fresh.status === "ready") {
    assert.equal(fresh.ageMs, 60_000);
    assert.equal(fresh.stale, false);
  }

  const stale = buildCatalogModel(snapshot({ fetchedAt: 1_000_000 }), 1_000_000 + 7 * 60 * 60 * 1000);
  assert.equal(stale.status, "ready");
  if (stale.status === "ready") assert.equal(stale.stale, true);
});
