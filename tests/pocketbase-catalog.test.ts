import assert from "node:assert/strict";
import { test } from "node:test";
import { createPocketBaseCatalogFetcher } from "../src/adapters/pocketbase-catalog.ts";
import type { PocketBaseClient } from "../src/adapters/pocketbase-client.ts";

function fakeClient(clients: unknown[], projects: unknown[], tasks: unknown[] = []): PocketBaseClient {
  return {
    list: async (collection: string) => {
      if (collection === "clients") return clients;
      if (collection === "projects") return projects;
      return tasks;
    },
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

test("maps PocketBase task records into domain HubTask, defaulting title to '' and an unrecognised status to 'open'", async () => {
  const client = fakeClient(
    [],
    [],
    [
      { id: "t1", title: "Fix the thing", project: "p1", status: "doing", external_ref: "JIRA-1" },
      { id: "t2", project: "p1" },
      { id: "t3", title: "Weird status", project: "p1", status: "blocked" },
    ],
  );

  const fetchCatalog = createPocketBaseCatalogFetcher(client);
  const { tasks } = await fetchCatalog();

  assert.deepEqual(tasks, [
    { id: "t1", title: "Fix the thing", projectId: "p1", status: "doing", externalRef: "JIRA-1" },
    { id: "t2", title: "", projectId: "p1", status: "open" },
    { id: "t3", title: "Weird status", projectId: "p1", status: "open" },
  ]);
});

test("omits externalRef when it is not a non-empty string", async () => {
  const client = fakeClient([], [], [{ id: "t1", title: "No ref", project: "p1", status: "open", external_ref: "" }]);

  const fetchCatalog = createPocketBaseCatalogFetcher(client);
  const { tasks } = await fetchCatalog();

  assert.equal("externalRef" in tasks[0]!, false);
});
