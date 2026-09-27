import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { createAssignScreen } from "../src/adapters/panel/screens/assign.ts";
import { buildAssignRows } from "../src/domain/panel-model.ts";
import type { HubAssign, HubAssignOutcome, SyncedTaskEntryRow } from "../src/adapters/hub-assign.ts";
import type { Catalog, CatalogSnapshot } from "../src/ports/catalog.ts";
import { DOWN, ENTER, ESCAPE, fakeHost } from "./helpers/panel-fakes.ts";

type TestComponent = Component & { handleInput: NonNullable<Component["handleInput"]> };

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const SNAPSHOT: CatalogSnapshot = {
  fetchedAt: 0,
  url: "https://pb.example.com",
  clients: [
    { id: "c-acme", name: "Acme", code: "acme", active: true },
    { id: "c-globex", name: "Globex", code: "globex", active: true },
  ],
  projects: [
    { id: "p-portal", name: "Portal", code: "portal", clientId: "c-acme", repoPaths: [], active: true },
    { id: "p-app", name: "App", code: "app", clientId: "c-globex", repoPaths: [], active: true },
  ],
};

const ROW: SyncedTaskEntryRow = {
  id: "rec-1",
  taskId: "task-1",
  prompt: "hello",
  startedAt: "2026-01-02 10:00:00.000Z",
  client: "c-acme",
  project: "p-portal",
};

class FakeCatalog implements Catalog {
  snapshot: CatalogSnapshot | undefined = SNAPSHOT;
  read(): CatalogSnapshot | undefined {
    return this.snapshot;
  }
  isStale(): boolean {
    return false;
  }
  async refresh(): Promise<CatalogSnapshot | undefined> {
    return this.snapshot;
  }
}

class FakeHubAssign implements HubAssign {
  rows: SyncedTaskEntryRow[] = [];
  listCalls = 0;
  assignCalls: Array<{ taskId: string; payload: { client: string; project: string } }> = [];
  assignOutcome: HubAssignOutcome = { kind: "assigned", recordId: "rec-1" };

  async listRecent(): Promise<SyncedTaskEntryRow[]> {
    this.listCalls += 1;
    return this.rows;
  }

  async assign(taskId: string, payload: { client: string; project: string }): Promise<HubAssignOutcome> {
    this.assignCalls.push({ taskId, payload });
    return this.assignOutcome;
  }
}

function makeScreen(options: { hubAssign: FakeHubAssign; catalog?: FakeCatalog }): { component: TestComponent; host: ReturnType<typeof fakeHost> } {
  const host = fakeHost();
  const factory = createAssignScreen({
    hubAssign: options.hubAssign,
    catalog: options.catalog ?? new FakeCatalog(),
  });
  return { component: factory(host) as TestComponent, host };
}

/** Drive the screen through its full happy path: pick the (first) task, the (first) client, the (first) project, then run Assign. */
function driveFullFlow(component: TestComponent): void {
  component.handleInput(ENTER); // open the task-entry submenu
  component.handleInput(ENTER); // pick the first synced row
  component.handleInput(DOWN); // task-entry -> client
  component.handleInput(ENTER); // open the client submenu
  component.handleInput(ENTER); // pick the first client
  component.handleInput(DOWN); // client -> project
  component.handleInput(ENTER); // open the project submenu
  component.handleInput(ENTER); // pick the first project
  component.handleInput(DOWN); // project -> assign
  component.handleInput(ENTER); // run the Assign action
}

test("buildAssignRows lists the task entry, client, project and assign rows", () => {
  const rows = buildAssignRows({ syncedRows: [], clients: [], projects: [] });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["task-entry", "client", "project", "assign"],
  );
  assert.equal(rows.find((row) => row.id === "task-entry")!.value, "— none —");
  assert.equal(rows.find((row) => row.id === "client")!.value, "— none —");
  const project = rows.find((row) => row.id === "project")!;
  assert.equal(project.value, "— none —");
  assert.equal(project.description, "pick a client first");
});

test("buildAssignRows shows the chosen row/client/project and drops the project hint once a client is chosen", () => {
  const rows = buildAssignRows({
    syncedRows: [{ taskId: "task-1", label: "1. 2026-01-02 — Acme · Portal — hello [task-1]" }],
    clients: [{ id: "c-acme", name: "Acme", code: "acme", active: true }],
    projects: [{ id: "p-portal", name: "Portal", clientId: "c-acme", repoPaths: [], active: true }],
    selectedTaskId: "task-1",
    selectedClientId: "c-acme",
    selectedProjectId: "p-portal",
  });
  assert.equal(rows.find((row) => row.id === "task-entry")!.value, "1. 2026-01-02 — Acme · Portal — hello [task-1]");
  assert.equal(rows.find((row) => row.id === "client")!.value, "Acme (acme)");
  const project = rows.find((row) => row.id === "project")!;
  assert.equal(project.value, "Portal");
  assert.equal(project.description, undefined);
});

test("the screen loads the recent synced rows once and renders its rows", async () => {
  const hubAssign = new FakeHubAssign();
  hubAssign.rows = [ROW];
  const { component } = makeScreen({ hubAssign });
  await flushMicrotasks();

  assert.equal(hubAssign.listCalls, 1);
  const lines = component.render(100).join("\n");
  assert.match(lines, /Task entry/);
  assert.match(lines, /Client/);
  assert.match(lines, /Project/);
  assert.match(lines, /Assign/);
});

test("the task-entry submenu lists the synced rows with the shared hub-actions label", async () => {
  const hubAssign = new FakeHubAssign();
  hubAssign.rows = [ROW];
  const { component } = makeScreen({ hubAssign });
  await flushMicrotasks();

  component.handleInput(ENTER); // open the task-entry submenu
  const open = component.render(100).join("\n");
  assert.match(open, /2026-01-02 10:00:00\.000Z — Acme · Portal — hello \[task-1\]/);

  component.handleInput(ENTER); // pick it
  assert.match(component.render(100).join("\n"), /2026-01-02 10:00:00\.000Z — Acme · Portal — hello \[task-1\]/);
});

test("the task-entry submenu reports the subcommand's wording when there are no synced rows", async () => {
  const hubAssign = new FakeHubAssign();
  const { component } = makeScreen({ hubAssign });
  await flushMicrotasks();

  component.handleInput(ENTER); // open the task-entry submenu
  assert.match(component.render(100).join("\n"), /no synced task entries found/);
});

test("the project submenu shows a note and closes without an error when no client is chosen", async () => {
  const hubAssign = new FakeHubAssign();
  hubAssign.rows = [ROW];
  const { component } = makeScreen({ hubAssign });
  await flushMicrotasks();

  component.handleInput(DOWN); // task-entry -> client
  component.handleInput(DOWN); // client -> project
  component.handleInput(ENTER); // open the project submenu -> note
  assert.match(component.render(100).join("\n"), /Pick a client first/);

  component.handleInput("x"); // any key closes it, no error
  assert.doesNotMatch(component.render(100).join("\n"), /Pick a client first/);
  assert.deepEqual(hubAssign.assignCalls, []);
});

test("the client submenu reports the subcommand's wording when no client is assignable", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = {
    ...SNAPSHOT,
    clients: [{ id: "c-sin", name: "Sin determinar", code: "sin", active: true, unassigned: true }],
  };
  const hubAssign = new FakeHubAssign();
  hubAssign.rows = [ROW];
  const { component } = makeScreen({ hubAssign, catalog });
  await flushMicrotasks();

  component.handleInput(DOWN); // task-entry -> client
  component.handleInput(ENTER); // open the client submenu
  assert.match(component.render(100).join("\n"), /no assignable client in the catalog/);
});

test("picking a task, client and project then running Assign PATCHes exactly the resolved pair and reports the shared result line", async () => {
  const hubAssign = new FakeHubAssign();
  hubAssign.rows = [ROW];
  const { component } = makeScreen({ hubAssign });
  await flushMicrotasks();

  driveFullFlow(component);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(hubAssign.assignCalls, [{ taskId: "task-1", payload: { client: "c-acme", project: "p-portal" } }]);
  assert.match(component.render(100).join("\n"), /assigned task-1 to Acme \(acme\) · Portal/);
});

test("running Assign without a project clears the relation, like the interactive subcommand", async () => {
  const hubAssign = new FakeHubAssign();
  hubAssign.rows = [ROW];
  const { component } = makeScreen({ hubAssign });
  await flushMicrotasks();

  component.handleInput(ENTER); // open the task-entry submenu
  component.handleInput(ENTER); // pick the first synced row
  component.handleInput(DOWN); // task-entry -> client
  component.handleInput(ENTER); // open the client submenu
  component.handleInput(ENTER); // pick Acme
  component.handleInput(DOWN); // client -> project
  component.handleInput(ENTER); // open the project submenu: Portal, (no project)
  component.handleInput(DOWN); // Portal -> (no project)
  component.handleInput(ENTER);
  component.handleInput(DOWN); // project -> assign
  component.handleInput(ENTER); // run Assign
  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(hubAssign.assignCalls, [{ taskId: "task-1", payload: { client: "c-acme", project: "" } }]);
});

test("the Assign action shows the subcommand's not-found wording when the row is gone from the hub", async () => {
  const hubAssign = new FakeHubAssign();
  hubAssign.rows = [ROW];
  hubAssign.assignOutcome = { kind: "not-found" };
  const { component } = makeScreen({ hubAssign });
  await flushMicrotasks();

  driveFullFlow(component);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.match(component.render(100).join("\n"), /error: no synced task entry with task_id task-1/);
});

test("the Assign action reports the subcommand's catalog wording when no snapshot is available", async () => {
  const catalog = new FakeCatalog();
  catalog.snapshot = undefined;
  const hubAssign = new FakeHubAssign();
  hubAssign.rows = [ROW];
  const { component } = makeScreen({ hubAssign, catalog });
  await flushMicrotasks();

  component.handleInput(ENTER); // open the task-entry submenu (labels fall back to raw ids)
  component.handleInput(ENTER); // pick the synced row
  component.handleInput(DOWN); // task-entry -> client
  component.handleInput(DOWN); // client -> project
  component.handleInput(DOWN); // project -> assign
  component.handleInput(ENTER); // run Assign
  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(hubAssign.assignCalls, []);
  assert.match(component.render(100).join("\n"), /error: catalog unavailable; run '\/kankaku catalog refresh'/);
});

test("cancelling the task-entry submenu returns without an error and never assigns", async () => {
  const hubAssign = new FakeHubAssign();
  hubAssign.rows = [ROW];
  const { component } = makeScreen({ hubAssign });
  await flushMicrotasks();

  component.handleInput(ENTER); // open the task-entry submenu
  component.handleInput(ESCAPE); // cancel
  assert.deepEqual(hubAssign.assignCalls, []);
});

test("escape from the assign screen's list goes back", async () => {
  const hubAssign = new FakeHubAssign();
  hubAssign.rows = [ROW];
  const { component, host } = makeScreen({ hubAssign });
  await flushMicrotasks();

  component.handleInput(ESCAPE);
  assert.equal(host.backCalls, 1);
});
