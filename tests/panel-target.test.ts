import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createPanelComponent } from "../src/adapters/panel/kankaku-panel.ts";
import { createTargetScreen } from "../src/adapters/panel/screens/target.ts";
import type { SessionClient } from "../src/adapters/session-client.ts";
import type { SessionTarget } from "../src/adapters/session-target.ts";
import type { ClientSourceName, ClientSources } from "../src/domain/client-label.ts";
import { resolveWorkTarget } from "../src/domain/work-target.ts";
import type { Client, HubTask, Project, WorkTarget, WorkTargetCandidate, WorkTargetSessionOverride, WorkTargetSourceName } from "../src/domain/work-target.ts";
import type { Catalog, CatalogSnapshot } from "../src/ports/catalog.ts";
import { DOWN, ENTER, ESCAPE, fakeHost, fakeTheme, fakeTui } from "./helpers/panel-fakes.ts";
import type { FakeHost } from "./helpers/panel-fakes.ts";

type TestComponent = Component & {
  handleInput: NonNullable<Component["handleInput"]>;
};

const CLIENTS: Client[] = [
  { id: "c-acme", name: "Acme", code: "acme", active: true },
  { id: "c-globex", name: "Globex", code: "globex", active: true },
];
const PROJECTS: Project[] = [
  { id: "p-portal", name: "Portal", clientId: "c-acme", repoPaths: [], active: true },
  { id: "p-other", name: "Other client's project", clientId: "c-globex", repoPaths: [], active: true },
];
const TASKS: HubTask[] = [
  { id: "t-bug", title: "Fix the bug", projectId: "p-portal", status: "open" },
  { id: "t-docs", title: "Write docs", projectId: "p-portal", status: "open" },
  { id: "t-done", title: "Old and done", projectId: "p-portal", status: "done" },
];
const SNAPSHOT: CatalogSnapshot = { fetchedAt: 0, url: "https://pb.example.com", clients: CLIENTS, projects: PROJECTS, tasks: TASKS };

class FakeCatalog implements Catalog {
  private readonly snapshot: CatalogSnapshot | undefined;
  constructor(snapshot: CatalogSnapshot | undefined = SNAPSHOT) {
    this.snapshot = snapshot;
  }
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

/** A real `resolveWorkTarget`-backed double, so rebuilt rows reflect a mutation exactly like the production adapter would. */
class FakeSessionTarget implements SessionTarget {
  private sessionOverride: WorkTargetSessionOverride;
  readonly calls = {
    setExplicit: [] as WorkTargetCandidate[],
    clear: 0,
    setTask: [] as string[],
    clearTask: 0,
    rememberTarget: 0,
  };
  rememberResult = true;
  source: WorkTargetSourceName | undefined = "session";
  private readonly snapshot: CatalogSnapshot;

  constructor(snapshot: CatalogSnapshot, initial?: WorkTargetCandidate) {
    this.snapshot = snapshot;
    this.sessionOverride = initial;
  }

  private recompute(): WorkTarget | undefined {
    return resolveWorkTarget({
      session: this.sessionOverride,
      cwd: "/nowhere",
      clients: this.snapshot.clients,
      projects: this.snapshot.projects,
      tasks: this.snapshot.tasks ?? [],
    });
  }

  restore(): void {}
  async ensurePicked(): Promise<void> {}
  async pick(): Promise<void> {}

  setExplicit(_pi: ExtensionAPI, ids: WorkTargetCandidate): void {
    this.calls.setExplicit.push(ids);
    this.sessionOverride = ids;
  }
  clear(_pi: ExtensionAPI): void {
    this.calls.clear++;
    this.sessionOverride = undefined;
  }
  async pickTask(): Promise<void> {}
  clearTask(_pi: ExtensionAPI): void {
    this.calls.clearTask++;
    if (this.sessionOverride && typeof this.sessionOverride === "object") {
      const { hubTaskId: _h, ...rest } = this.sessionOverride;
      this.sessionOverride = rest;
    }
  }
  setTask(_pi: ExtensionAPI, hubTaskId: string): void {
    this.calls.setTask.push(hubTaskId);
    if (this.sessionOverride && typeof this.sessionOverride === "object") {
      this.sessionOverride = { ...this.sessionOverride, hubTaskId };
    }
  }
  rememberTarget(): boolean {
    this.calls.rememberTarget++;
    return this.rememberResult;
  }
  effectiveTarget(): WorkTarget | undefined {
    return this.recompute();
  }
  effectiveSource(): WorkTargetSourceName | undefined {
    return this.source;
  }
  runTarget(): WorkTarget | undefined {
    return this.recompute();
  }
  idleTarget(): WorkTarget | undefined {
    return this.recompute();
  }
  endRun(): void {}
}

class FakeSessionClient implements SessionClient {
  client: string | undefined;
  source: ClientSourceName | undefined = "session";
  readonly setCalls: Array<string | undefined> = [];

  restore(): void {}
  set(_pi: ExtensionAPI, client: string | undefined): void {
    this.setCalls.push(client);
    this.client = client;
  }
  sources(): ClientSources {
    return { session: this.client };
  }
  effectiveClient(): string | undefined {
    return this.client;
  }
  effectiveSource(): ClientSourceName | undefined {
    return this.source;
  }
  runClient(): string | undefined {
    return this.client;
  }
  idleClient(): string | undefined {
    return this.client;
  }
  endRun(): void {}
}

function makeFakePi(): ExtensionAPI & { appended: Array<{ customType: string; data: unknown }> } {
  const appended: Array<{ customType: string; data: unknown }> = [];
  return { appended, appendEntry: (customType: string, data?: unknown) => appended.push({ customType, data }) } as unknown as ExtensionAPI & {
    appended: Array<{ customType: string; data: unknown }>;
  };
}

function makeCtx(): ExtensionContext {
  return { hasUI: true, cwd: "/nowhere" } as unknown as ExtensionContext;
}

test("subagent role renders a read-only note, no rows", () => {
  const host = fakeHost();
  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "subagent",
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
  });
  const component = factory(host);

  const lines = component.render(80);
  assert.ok(lines.some((line) => line.includes("Subagent session")));
  assert.ok(lines.some((line) => line.includes("inherited from the orchestrator")));
});

test("rows render current values: client, project, task, source, remember, legacy", () => {
  const catalog = new FakeCatalog();
  const sessionTarget = new FakeSessionTarget(SNAPSHOT, { clientId: "c-acme", projectId: "p-portal" });
  const sessionClient = new FakeSessionClient();
  sessionClient.client = "acme-legacy";
  const host = fakeHost();
  const refreshCalls: unknown[] = [];

  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionTarget,
    sessionClient,
    catalog,
    refreshIdleStatus: () => refreshCalls.push(undefined),
  });
  const component = factory(host);

  const lines = component.render(80).join("\n");
  assert.match(lines, /Acme \(acme\)/);
  assert.match(lines, /Portal/);
  assert.match(lines, /session/);
  assert.match(lines, /save to config\.json/);
  assert.match(lines, /acme-legacy/);
});

test("picking a client calls setExplicit with only clientId (project/task dropped)", () => {
  const catalog = new FakeCatalog();
  const sessionTarget = new FakeSessionTarget(SNAPSHOT);
  const host = fakeHost();
  const refreshCalls: unknown[] = [];

  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionTarget,
    sessionClient: new FakeSessionClient(),
    catalog,
    refreshIdleStatus: () => refreshCalls.push(undefined),
  });
  const component = factory(host) as TestComponent;

  // Row order: client, project, task, source, remember, legacy. "client" is topmost.
  component.handleInput(ENTER); // open the client submenu
  // Submenu items sorted by name: Acme, Globex, — use defaults —. Acme is topmost.
  component.handleInput(ENTER); // pick Acme

  assert.deepEqual(sessionTarget.calls.setExplicit, [{ clientId: "c-acme" }]);
  assert.equal(refreshCalls.length, 1);
  assert.match(component.render(80).join("\n"), /Acme \(acme\)/);
});

test("'— use defaults —' calls sessionTarget.clear", () => {
  const catalog = new FakeCatalog();
  const sessionTarget = new FakeSessionTarget(SNAPSHOT, { clientId: "c-acme" });
  const host = fakeHost();

  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionTarget,
    sessionClient: new FakeSessionClient(),
    catalog,
    refreshIdleStatus: () => {},
  });
  const component = factory(host) as TestComponent;

  component.handleInput(ENTER); // open the client submenu
  component.handleInput(DOWN); // Acme -> Globex
  component.handleInput(DOWN); // Globex -> — use defaults —
  component.handleInput(ENTER);

  assert.equal(sessionTarget.calls.clear, 1);
  assert.deepEqual(sessionTarget.calls.setExplicit, []);
});

test("the project submenu shows a note and closes on any key when there is no client", () => {
  const sessionTarget = new FakeSessionTarget(SNAPSHOT);
  const host = fakeHost();
  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionTarget,
    sessionClient: new FakeSessionClient(),
    catalog: new FakeCatalog(),
    refreshIdleStatus: () => {},
  });
  const component = factory(host) as TestComponent;

  component.handleInput(DOWN); // client -> project
  component.handleInput(ENTER); // open project submenu -> note
  assert.match(component.render(80).join("\n"), /Pick a client first/);

  component.handleInput("x"); // any key closes it
  assert.doesNotMatch(component.render(80).join("\n"), /Pick a client first/);
});

test("selecting a task calls setTask with its id and refreshes idle status", () => {
  const catalog = new FakeCatalog();
  const sessionTarget = new FakeSessionTarget(SNAPSHOT, { clientId: "c-acme", projectId: "p-portal" });
  const host = fakeHost();
  const refreshCalls: unknown[] = [];

  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionTarget,
    sessionClient: new FakeSessionClient(),
    catalog,
    refreshIdleStatus: () => refreshCalls.push(undefined),
  });
  const component = factory(host) as TestComponent;

  component.handleInput(DOWN); // client -> project
  component.handleInput(DOWN); // project -> task
  component.handleInput(ENTER); // open task submenu: Fix the bug, Write docs, — none —
  component.handleInput(DOWN); // Fix the bug -> Write docs
  component.handleInput(ENTER); // pick Write docs

  assert.deepEqual(sessionTarget.calls.setTask, ["t-docs"]);
  assert.equal(refreshCalls.length, 1);
  assert.match(component.render(80).join("\n"), /Write docs/);
});

test("'— none —' in the task submenu calls clearTask", () => {
  const catalog = new FakeCatalog({ ...SNAPSHOT, tasks: [TASKS[0]!] }); // exactly one open task
  const sessionTarget = new FakeSessionTarget(SNAPSHOT, { clientId: "c-acme", projectId: "p-portal", hubTaskId: "t-bug" });
  const host = fakeHost();

  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionTarget,
    sessionClient: new FakeSessionClient(),
    catalog,
    refreshIdleStatus: () => {},
  });
  const component = factory(host) as TestComponent;

  component.handleInput(DOWN); // client -> project
  component.handleInput(DOWN); // project -> task
  component.handleInput(ENTER); // open task submenu: Fix the bug, — none —
  component.handleInput(DOWN); // Fix the bug -> — none —
  component.handleInput(ENTER);

  assert.equal(sessionTarget.calls.clearTask, 1);
  assert.deepEqual(sessionTarget.calls.setTask, []);
});

test("the task submenu shows 'no open tasks' when the project has none", () => {
  const catalog = new FakeCatalog({ ...SNAPSHOT, tasks: [] });
  const sessionTarget = new FakeSessionTarget(SNAPSHOT, { clientId: "c-acme", projectId: "p-portal" });
  const host = fakeHost();

  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionTarget,
    sessionClient: new FakeSessionClient(),
    catalog,
    refreshIdleStatus: () => {},
  });
  const component = factory(host) as TestComponent;

  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(ENTER);

  assert.match(component.render(80).join("\n"), /No open tasks for this project in the hub/);
});

test("legacy label: Enter with a valid value calls sessionClient.set and closes", () => {
  const sessionClient = new FakeSessionClient(); // no label yet: an empty Input, so cursor position never matters
  const host = fakeHost();
  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionClient,
    refreshIdleStatus: () => {},
  });
  const component = factory(host) as TestComponent;

  // No hub configured (no sessionTarget): the only row is "legacy".
  component.handleInput(ENTER); // open the legacy Input (empty)
  for (const ch of "new-label") component.handleInput(ch);
  component.handleInput(ENTER); // submit

  assert.deepEqual(sessionClient.setCalls, ["new-label"]);
  assert.match(component.render(80).join("\n"), /new-label/);
});

test("legacy label: an invalid value shows an inline error and never calls sessionClient.set", () => {
  const sessionClient = new FakeSessionClient();
  const host = fakeHost();
  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionClient,
    refreshIdleStatus: () => {},
  });
  const component = factory(host) as TestComponent;

  component.handleInput(ENTER); // open the legacy Input (empty)
  for (const ch of "not valid!") component.handleInput(ch);
  component.handleInput(ENTER); // submit an invalid label (contains a space and '!')

  assert.deepEqual(sessionClient.setCalls, []);
  assert.match(component.render(80).join("\n"), /error/);
});

test("legacy label: Escape cancels without calling sessionClient.set", () => {
  const sessionClient = new FakeSessionClient();
  sessionClient.client = "kept";
  const host = fakeHost();
  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionClient,
    refreshIdleStatus: () => {},
  });
  const component = factory(host) as TestComponent;

  component.handleInput(ENTER);
  component.handleInput("x");
  component.handleInput(ESCAPE);

  assert.deepEqual(sessionClient.setCalls, []);
  assert.match(component.render(80).join("\n"), /kept/);
});

test("opening and closing the legacy Input toggles PanelHost.setBodyWantsText", () => {
  const sessionClient = new FakeSessionClient();
  const host = fakeHost();
  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionClient,
    refreshIdleStatus: () => {},
  });
  const component = factory(host) as TestComponent;

  component.handleInput(ENTER);
  assert.equal(host.bodyWantsText, true);

  component.handleInput(ESCAPE);
  assert.equal(host.bodyWantsText, false);
});

test("the 'remember' row runs SessionTarget#rememberTarget and shows the result", async () => {
  const catalog = new FakeCatalog();
  const sessionTarget = new FakeSessionTarget(SNAPSHOT, { clientId: "c-acme", projectId: "p-portal" });
  const host = fakeHost();
  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionTarget,
    sessionClient: new FakeSessionClient(),
    catalog,
    refreshIdleStatus: () => {},
  });
  const component = factory(host) as TestComponent;

  component.handleInput(DOWN); // client -> project
  component.handleInput(DOWN); // project -> task
  component.handleInput(DOWN); // task -> source
  component.handleInput(DOWN); // source -> remember
  component.handleInput(ENTER); // run it

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sessionTarget.calls.rememberTarget, 1);
  assert.match(component.render(80).join("\n"), /saved clientId\/projectId to config\.json/);
});

test("escape inside the task submenu closes the submenu and keeps the Target screen; a second escape goes back", () => {
  const catalog = new FakeCatalog();
  const sessionTarget = new FakeSessionTarget(SNAPSHOT, { clientId: "c-acme", projectId: "p-portal" });
  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionTarget,
    sessionClient: new FakeSessionClient(),
    catalog,
    refreshIdleStatus: () => {},
  });
  type TestPanelComponent = Component & { handleInput: NonNullable<Component["handleInput"]>; render: NonNullable<Component["render"]> };
  const panel = createPanelComponent(fakeTui(), fakeTheme(), { hubConfigured: true, screens: { target: factory } }, () => {}) as TestPanelComponent;

  panel.handleInput(ENTER); // root -> target (topmost when hubConfigured)
  assert.equal(panel.render(80)[0], "kankaku · Target");

  panel.handleInput(DOWN); // client -> project
  panel.handleInput(DOWN); // project -> task
  panel.handleInput(ENTER); // open the task submenu (2 open tasks for p-portal)

  panel.handleInput(ESCAPE); // closes only the submenu
  assert.equal(panel.render(80)[0], "kankaku · Target");

  panel.handleInput(ESCAPE); // now goes back to root
  assert.equal(panel.render(80)[0], "kankaku");
});

test("no hub configured (no sessionTarget): only the legacy row is shown", () => {
  const host = fakeHost();
  const factory = createTargetScreen({
    pi: makeFakePi(),
    ctx: makeCtx(),
    role: "orchestrator",
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
  });
  const component = factory(host) as TestComponent;

  const lines = component.render(80).join("\n");
  assert.doesNotMatch(lines, /Client/);
  assert.match(lines, /Legacy label/);
});
