import assert from "node:assert/strict";
import { test } from "node:test";
import { createPocketBaseCatalogFetcher } from "../src/adapters/pocketbase-catalog.ts";
import type { PocketBaseClient } from "../src/adapters/pocketbase-client.ts";

function fakeClient(clients: unknown[], projects: unknown[]): PocketBaseClient {
  return {
    list: async (collection: string) => (collection === "clients" ? clients : projects),
  } as unknown as PocketBaseClient;
}

test("maps PocketBase client and project records into domain Client/Project", async () => {
  const client = fakeClient(
    [
      { id: "c1", name: "Acme", code: "acme", active: true },
      { id: "c2", name: "Sin determinar", code: "unassigned", active: true, unassigned: true },
    ],
    [{ id: "p1", name: "Portal", code: "portal", client: "c1", repo_paths: ["/repos/portal"], active: true }],
  );

  const fetchCatalog = createPocketBaseCatalogFetcher(client);
  const { clients, projects } = await fetchCatalog();

  assert.deepEqual(clients, [
    { id: "c1", name: "Acme", code: "acme", active: true },
    { id: "c2", name: "Sin determinar", code: "unassigned", active: true, unassigned: true },
  ]);
  assert.deepEqual(projects, [{ id: "p1", name: "Portal", code: "portal", clientId: "c1", repoPaths: ["/repos/portal"], active: true }]);
});

test("defaults active/unassigned to false and repo_paths to [] when absent or malformed", async () => {
  const client = fakeClient([{ id: "c1", name: "Acme", code: "acme" }], [{ id: "p1", name: "Portal", client: "c1", repo_paths: null }]);

  const fetchCatalog = createPocketBaseCatalogFetcher(client);
  const { clients, projects } = await fetchCatalog();

  assert.deepEqual(clients, [{ id: "c1", name: "Acme", code: "acme", active: false }]);
  assert.deepEqual(projects, [{ id: "p1", name: "Portal", clientId: "c1", repoPaths: [], active: false }]);
});

test("filters non-string entries out of repo_paths", async () => {
  const client = fakeClient([], [{ id: "p1", name: "Portal", client: "c1", repo_paths: ["/ok", 42, null], active: true }]);

  const fetchCatalog = createPocketBaseCatalogFetcher(client);
  const { projects } = await fetchCatalog();

  assert.deepEqual(projects[0]?.repoPaths, ["/ok"]);
});
