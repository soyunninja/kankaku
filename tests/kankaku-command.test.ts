import assert from "node:assert/strict";
import { test } from "node:test";
import { registerKankakuCommand } from "../src/adapters/kankaku-command.ts";
import type { SessionClient } from "../src/adapters/session-client.ts";
import { createSessionTarget } from "../src/adapters/session-target.ts";
import type { ClientSourceName } from "../src/domain/client-label.ts";
import type { WorkRecord } from "../src/domain/work-record.ts";
import type { Catalog, CatalogSnapshot } from "../src/ports/catalog.ts";
import type { WorkLog } from "../src/ports/work-log.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

class FakeCatalog implements Catalog {
  snapshot: CatalogSnapshot | undefined;
  refreshResult: CatalogSnapshot | undefined;

  read(): CatalogSnapshot | undefined {
    return this.snapshot;
  }
  isStale(): boolean {
    return false;
  }
  async refresh(): Promise<CatalogSnapshot | undefined> {
    if (this.refreshResult) this.snapshot = this.refreshResult;
    return this.refreshResult;
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

function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schema: 1,
    id: "rec",
    role: "orchestrator",
    pid: 1,
    parentPid: 0,
    project: "/abs/project",
    prompt: "hello",
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    wallMs: 0,
    waitingMs: 0,
    workMs: 0,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    status: "completed",
    ...overrides,
  };
}

class FakeWorkLog implements WorkLog {
  readonly records: WorkRecord[] = [];
  readAllCalls = 0;
  append(record: WorkRecord): void {
    this.records.push(record);
  }
  readAll(): WorkRecord[] {
    this.readAllCalls++;
    return this.records;
  }
}

/** A minimal {@link SessionClient} double that records calls instead of resolving real client sources. */
class FakeSessionClient implements SessionClient {
  setCalls: Array<string | undefined> = [];
  effective: string | undefined;
  source: ClientSourceName | undefined = undefined;

  restore(): void {}
  set(_pi: ExtensionAPI, client: string | undefined): void {
    this.setCalls.push(client);
    this.effective = client;
  }
  sources() {
    return {};
  }
  effectiveClient(): string | undefined {
    return this.effective;
  }
  effectiveSource() {
    return this.source;
  }
  runClient(): string | undefined {
    return undefined;
  }
  idleClient(): string | undefined {
    return undefined;
  }
  endRun(): void {}
}

interface FakeCommandOptions {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  getArgumentCompletions?: (argumentPrefix: string) => unknown;
}

class FakePi {
  readonly commands = new Map<string, FakeCommandOptions>();
  readonly entries: Array<{ customType: string; data: unknown }> = [];
  readonly renderers = new Set<string>();

  appendEntry(customType: string, data?: unknown): void {
    this.entries.push({ customType, data });
  }
  registerEntryRenderer(customType: string): void {
    this.renderers.add(customType);
  }
  registerCommand(name: string, options: FakeCommandOptions): void {
    this.commands.set(name, options);
  }
}

function makeCtx(overrides: Record<string, unknown> = {}): ExtensionContext {
  return {
    hasUI: true,
    sessionManager: { getSessionId: () => "session-1" },
    ui: { notify: () => {}, setStatus: () => {} },
    ...overrides,
  } as unknown as ExtensionContext;
}

test("registers the kankaku command and its durable report entry renderer", () => {
  const pi = new FakePi();
  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
  });

  assert.ok(pi.commands.has("kankaku"));
  assert.ok(pi.renderers.has("kankaku-report"));
});

test("the plain command shows a durable summary report when a UI is available, and falls back to notify otherwise", async () => {
  const pi = new FakePi();
  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
  });

  await pi.commands.get("kankaku")!.handler("", makeCtx());
  assert.equal(pi.entries.length, 1);
  assert.equal(pi.entries[0]!.customType, "kankaku-report");

  const notified: string[] = [];
  await pi.commands
    .get("kankaku")!
    .handler("", makeCtx({ hasUI: false, ui: { notify: (msg: string) => notified.push(msg), setStatus: () => {} } }));
  assert.equal(notified.length, 1);
});

test("'client <name>' sets the session client, persists it and refreshes the idle status", async () => {
  const pi = new FakePi();
  const sessionClient = new FakeSessionClient();
  let refreshed = 0;
  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient,
    refreshIdleStatus: () => {
      refreshed += 1;
    },
  });

  await pi.commands.get("kankaku")!.handler("client acme", makeCtx());

  assert.deepEqual(sessionClient.setCalls, ["acme"]);
  assert.equal(refreshed, 1);
  assert.equal(pi.entries.at(-1)!.customType, "kankaku-report");
});

test("'client --clear' clears the session client and refreshes the idle status", async () => {
  const pi = new FakePi();
  const sessionClient = new FakeSessionClient();
  let refreshed = 0;
  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient,
    refreshIdleStatus: () => {
      refreshed += 1;
    },
  });

  await pi.commands.get("kankaku")!.handler("client --clear", makeCtx());

  assert.deepEqual(sessionClient.setCalls, [undefined]);
  assert.equal(refreshed, 1);
});

test("'export' notifies an error when no writeExportFile is configured", async () => {
  const pi = new FakePi();
  const notified: Array<{ message: string; type?: string }> = [];
  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
  });

  await pi.commands
    .get("kankaku")!
    .handler("export", makeCtx({ ui: { notify: (message: string, type?: string) => notified.push({ message, type }), setStatus: () => {} } }));

  assert.equal(pi.entries.length, 0);
  assert.equal(notified[0]?.type, "error");
});

test("getArgumentCompletions lists the known subcommands, and invalidateClientNames forces client names to be re-read", async () => {
  const log = new FakeWorkLog();
  log.append(makeRecord({ id: "r1", client: "acme" }));
  const pi = new FakePi();

  const command = registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log,
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
  });

  const tokens = (await pi.commands.get("kankaku")!.getArgumentCompletions!("")) as Array<{ value: string }>;
  assert.deepEqual(
    tokens.map((t) => t.value).sort(),
    ["all", "client", "clients", "export", "sessions", "tasks"],
  );

  await pi.commands.get("kankaku")!.getArgumentCompletions!("client ");
  await pi.commands.get("kankaku")!.getArgumentCompletions!("client ");
  assert.equal(log.readAllCalls, 1, "the client-name list is cached across completions");

  command.invalidateClientNames();
  await pi.commands.get("kankaku")!.getArgumentCompletions!("client ");
  assert.equal(log.readAllCalls, 2, "invalidateClientNames forces the next completion to re-read the log");
});

test("getArgumentCompletions includes target/projects/catalog only when the hub is configured", async () => {
  const pi = new FakePi();
  const catalog = new FakeCatalog();
  const sessionTarget = createSessionTarget({
    role: "orchestrator",
    catalog,
    resolveProjectConfigIds: () => undefined,
    persistProjectConfig: () => {},
  });

  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
    sessionTarget,
    catalog,
  });

  const tokens = (await pi.commands.get("kankaku")!.getArgumentCompletions!("")) as Array<{ value: string }>;
  assert.deepEqual(
    tokens.map((t) => t.value).sort(),
    ["all", "catalog", "client", "clients", "export", "projects", "sessions", "target", "tasks"],
  );
});

test("'target' with no args reports 'target: none' when the hub is configured but nothing resolves", async () => {
  const pi = new FakePi();
  const catalog = new FakeCatalog();
  const sessionTarget = createSessionTarget({
    role: "orchestrator",
    catalog,
    resolveProjectConfigIds: () => undefined,
    persistProjectConfig: () => {},
  });

  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
    sessionTarget,
  });

  await pi.commands.get("kankaku")!.handler("target", makeCtx());

  const data = pi.entries.at(-1)!.data as { title: string; lines: string[] };
  assert.equal(data.title, "target");
  assert.equal(data.lines[0], "target: none");
});

test("'target' notifies 'hub is not configured' when no sessionTarget is present", async () => {
  const pi = new FakePi();
  const notified: Array<{ message: string; type?: string }> = [];
  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
  });

  await pi.commands
    .get("kankaku")!
    .handler("target", makeCtx({ ui: { notify: (message: string, type?: string) => notified.push({ message, type }), setStatus: () => {} } }));

  assert.match(notified[0]?.message ?? "", /not configured/);
});

test("'target pick' runs the picker, reports the result, and refreshes the idle status", async () => {
  const pi = new FakePi();
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const sessionTarget = createSessionTarget({
    role: "orchestrator",
    catalog,
    resolveProjectConfigIds: () => undefined,
    persistProjectConfig: () => {},
  });
  let refreshed = 0;
  const selectResponses = ["Acme", "(no project)"];
  let selectIndex = 0;

  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {
      refreshed += 1;
    },
    sessionTarget,
  });

  await pi.commands.get("kankaku")!.handler(
    "target pick",
    makeCtx({ ui: { notify: () => {}, setStatus: () => {}, select: async () => selectResponses[selectIndex++], confirm: async () => false } }),
  );

  assert.equal(refreshed, 1);
  const data = pi.entries.at(-1)!.data as { title: string; lines: string[] };
  assert.match(data.lines[0]!, /target set to Acme/);
});

test("'target clear' clears the session target and refreshes the idle status", async () => {
  const pi = new FakePi();
  const catalog = new FakeCatalog();
  const sessionTarget = createSessionTarget({
    role: "orchestrator",
    catalog,
    resolveProjectConfigIds: () => undefined,
    persistProjectConfig: () => {},
  });
  let refreshed = 0;

  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {
      refreshed += 1;
    },
    sessionTarget,
  });

  await pi.commands.get("kankaku")!.handler("target clear", makeCtx());

  assert.equal(refreshed, 1);
  const data = pi.entries.at(-1)!.data as { title: string; lines: string[] };
  assert.equal(data.lines[0], "target cleared for this session");
});

test("'catalog refresh' reports client/project counts", async () => {
  const pi = new FakePi();
  const catalog = new FakeCatalog();
  catalog.refreshResult = SNAPSHOT;

  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
    catalog,
  });

  await pi.commands.get("kankaku")!.handler("catalog refresh", makeCtx());

  const data = pi.entries.at(-1)!.data as { title: string; lines: string[] };
  assert.equal(data.title, "catalog");
  assert.match(data.lines[0]!, /2 client\(s\), 1 project\(s\)/);
});

test("'catalog refresh' notifies an error when the hub is unreachable", async () => {
  const pi = new FakePi();
  const catalog = new FakeCatalog();
  const notified: Array<{ message: string; type?: string }> = [];

  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
    catalog,
  });

  await pi.commands
    .get("kankaku")!
    .handler(
      "catalog refresh",
      makeCtx({ ui: { notify: (message: string, type?: string) => notified.push({ message, type }), setStatus: () => {} } }),
    );

  assert.equal(notified[0]?.type, "error");
});

test("'projects' appends a durable report entry with per-project totals", async () => {
  const log = new FakeWorkLog();
  log.append(makeRecord({ id: "r1", projectId: "p-portal", projectName: "Portal" }));
  const pi = new FakePi();

  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log,
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
  });

  await pi.commands.get("kankaku")!.handler("projects", makeCtx());

  const data = pi.entries.at(-1)!.data as { title: string; lines: string[] };
  assert.match(data.lines.join("\n"), /Portal/);
});

test("'client <code>' sets the hub target when the hub is configured, case-insensitively", async () => {
  const pi = new FakePi();
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const sessionTarget = createSessionTarget({
    role: "orchestrator",
    catalog,
    resolveProjectConfigIds: () => undefined,
    persistProjectConfig: () => {},
  });
  let refreshed = 0;

  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {
      refreshed += 1;
    },
    sessionTarget,
    catalog,
  });

  await pi.commands.get("kankaku")!.handler("client ACME", makeCtx());

  assert.equal(refreshed, 1);
  assert.equal(sessionTarget.effectiveTarget()?.clientId, "c-acme");
  const data = pi.entries.at(-1)!.data as { title: string; lines: string[] };
  assert.match(data.lines[0]!, /Acme \(acme\)/);
});

test("'client <name>' notifies an error listing valid codes when the hub is configured and the name does not match", async () => {
  const pi = new FakePi();
  const catalog = new FakeCatalog();
  catalog.snapshot = SNAPSHOT;
  const sessionTarget = createSessionTarget({
    role: "orchestrator",
    catalog,
    resolveProjectConfigIds: () => undefined,
    persistProjectConfig: () => {},
  });
  const notified: Array<{ message: string; type?: string }> = [];

  registerKankakuCommand(pi as unknown as ExtensionAPI, {
    log: new FakeWorkLog(),
    sessionClient: new FakeSessionClient(),
    refreshIdleStatus: () => {},
    sessionTarget,
    catalog,
  });

  await pi.commands
    .get("kankaku")!
    .handler(
      "client nope",
      makeCtx({ ui: { notify: (message: string, type?: string) => notified.push({ message, type }), setStatus: () => {} } }),
    );

  assert.match(notified[0]?.message ?? "", /unknown client: nope/);
  assert.match(notified[0]?.message ?? "", /acme, globex/);
});
