import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client, HubTask, Project } from "kankaku-pi/domain";
import type { SessionList } from "../src/session-target-store.ts";
import { activeClients, activeProjects, pickBoth, pickTarget, taskLinkOutcome } from "../src/target-select.ts";

const CLIENTS: Client[] = [
  { id: "c-unassigned", name: "Sin determinar", code: "SIN", active: true, unassigned: true },
  { id: "c-zed", name: "Zed Studio", code: "zed", active: true },
  { id: "c-acme", name: "Acme Corp", code: "acme", active: true },
  { id: "c-acme2", name: "Acme Corp Labs", code: "acme-labs", active: true },
  { id: "c-old", name: "Old Client", code: "old", active: false },
];
const PROJECTS: Project[] = [
  { id: "p-web", name: "Web", code: "web", clientId: "c-acme", repoPaths: [], active: true },
  { id: "p-api", name: "API Gateway", clientId: "c-acme", repoPaths: [], active: true },
  { id: "p-app", name: "API App", clientId: "c-acme", repoPaths: [], active: true },
  { id: "p-dead", name: "Retired", clientId: "c-acme", repoPaths: [], active: false },
  { id: "p-zweb", name: "Zed Web", code: "zweb", clientId: "c-zed", repoPaths: [], active: true },
];
const TASKS: HubTask[] = [
  { id: "t-web", title: "Fix login", projectId: "p-web", status: "open" },
  { id: "t-api", title: "Ship endpoint", projectId: "p-api", status: "doing" },
];

// Listed order: Acme Corp, Acme Corp Labs, Zed Studio (by name).
const clientsList: SessionList = { kind: "clients", ids: ["c-acme", "c-acme2", "c-zed"] };
// Acme's projects by name: API App, API Gateway, Web.
const projectsList: SessionList = { kind: "projects", ids: ["p-app", "p-api", "p-web"] };
const none: SessionList = { kind: "tasks", ids: [] };

const ctx = (lastList: SessionList, clientId?: string) => ({ clients: CLIENTS, projects: PROJECTS, lastList, ...(clientId ? { clientId } : {}) });
const clientOf = (id: string) => CLIENTS.find((c) => c.id === id)!;
const projectOf = (id: string) => PROJECTS.find((p) => p.id === id)!;

test("activeClients lists active clients by name and never the unassigned one or inactive ones", () => {
  assert.deepEqual(activeClients(CLIENTS).map((c) => c.id), ["c-acme", "c-acme2", "c-zed"]);
});

test("activeProjects lists the client's active projects by name", () => {
  assert.deepEqual(activeProjects(PROJECTS, "c-acme").map((p) => p.id), ["p-app", "p-api", "p-web"]);
  assert.deepEqual(activeProjects(PROJECTS, "c-old"), []);
});

test("a number picks from the last clients list", () => {
  assert.deepEqual(pickTarget("1", ctx(clientsList)), { kind: "client", client: clientOf("c-acme") });
  assert.deepEqual(pickTarget("3", ctx(clientsList)), { kind: "client", client: clientOf("c-zed") });
});

test("numbers out of range, zero, negative and huge are refused with the valid range", () => {
  for (const arg of ["0", "4", "-1", "99999999999999999999"]) {
    const r = pickTarget(arg, ctx(clientsList));
    assert.equal(r.kind, "unknown", arg);
    assert.match((r as { message: string }).message, /is not on the list \(1-3\)/, arg);
  }
});

test("a number with no list shown, or with a list of another kind, is refused", () => {
  assert.match((pickTarget("1", ctx({ kind: "clients", ids: [] })) as { message: string }).message, /no client list shown yet.*list the clients first/);
  assert.match((pickTarget("1", ctx(none)) as { message: string }).message, /no client list shown yet/);
  assert.match((pickTarget("1", ctx({ kind: "tasks", ids: ["t-web"] })) as { message: string }).message, /last list shown was tasks, not clients/);
  // projects list without a session client cannot be used for projects: it is a kind mismatch
  assert.match((pickTarget("1", ctx(projectsList)) as { message: string }).message, /last list shown was projects, not clients/);
});

test("a number on a clients list whose entry became inactive is refused, never selected", () => {
  const stale: SessionList = { kind: "clients", ids: ["c-old", "c-unassigned", "gone"] };
  for (const arg of ["1", "2", "3"]) {
    const r = pickTarget(arg, ctx(stale));
    assert.equal(r.kind, "unknown", arg);
    assert.match((r as { message: string }).message, /no longer available/, arg);
  }
});

test("a client is matched by code, exact and case-insensitive", () => {
  assert.deepEqual(pickTarget("ACME", ctx(none)), { kind: "client", client: clientOf("c-acme") });
  assert.deepEqual(pickTarget("Zed", ctx(none)), { kind: "client", client: clientOf("c-zed") });
});

test("a client is matched by a unique case-insensitive substring of its name", () => {
  assert.deepEqual(pickTarget("studio", ctx(none)), { kind: "client", client: clientOf("c-zed") });
  assert.deepEqual(pickTarget("corp labs", ctx(none)), { kind: "client", client: clientOf("c-acme2") });
});

test("the code wins over a name substring, and an exact name wins over longer names containing it", () => {
  // "acme" is the exact code of Acme Corp although it is also a substring of Acme Corp Labs
  assert.deepEqual(pickTarget("acme", ctx(none)), { kind: "client", client: clientOf("c-acme") });
  // "Acme Corp" is the exact name of one client and a substring of another
  assert.deepEqual(pickTarget("acme corp", ctx(none)), { kind: "client", client: clientOf("c-acme") });
});

test("an ambiguous substring lists the candidates and picks nothing", () => {
  const r = pickTarget("corp", ctx(none));
  assert.equal(r.kind, "ambiguous");
  assert.deepEqual((r as { candidates: Client[] }).candidates.map((c) => c.id), ["c-acme", "c-acme2"]);
  assert.equal((r as { of: string }).of, "clients");
});

test("inactive and unassigned clients are never matched by code or name", () => {
  for (const arg of ["old", "Old Client", "SIN", "Sin determinar", "determinar"]) {
    assert.equal(pickTarget(arg, ctx(none)).kind, "unknown", arg);
  }
});

test("empty input and unmatched text are unknown", () => {
  assert.deepEqual(pickTarget("  ", ctx(none)), { kind: "unknown", message: "no client given" });
  assert.deepEqual(pickTarget("nothing", ctx(none)), { kind: "unknown", message: 'no client matches "nothing"' });
});

test("with a projects list shown, a number picks a project of the session client", () => {
  assert.deepEqual(pickTarget("3", ctx(projectsList, "c-acme")), { kind: "project", project: projectOf("p-web") });
  assert.deepEqual(pickTarget("1", ctx(projectsList, "c-acme")), { kind: "project", project: projectOf("p-app") });
});

test("with a projects list shown, numbers out of range are refused and never fall back to clients", () => {
  const r = pickTarget("4", ctx(projectsList, "c-acme"));
  assert.equal(r.kind, "unknown");
  assert.match((r as { message: string }).message, /is not on the list \(1-3\)/);
});

test("with a projects list shown, a project code or unique name substring picks the project", () => {
  assert.deepEqual(pickTarget("WEB", ctx(projectsList, "c-acme")), { kind: "project", project: projectOf("p-web") });
  assert.deepEqual(pickTarget("gateway", ctx(projectsList, "c-acme")), { kind: "project", project: projectOf("p-api") });
});

test("with a projects list shown, an ambiguous project text lists the projects", () => {
  const r = pickTarget("api", ctx(projectsList, "c-acme"));
  assert.equal(r.kind, "ambiguous");
  assert.equal((r as { of: string }).of, "projects");
  assert.deepEqual((r as { candidates: Project[] }).candidates.map((p) => p.id), ["p-app", "p-api"]);
});

test("with a projects list shown, text that is no project of the client can still name a client", () => {
  assert.deepEqual(pickTarget("zed", ctx(projectsList, "c-acme")), { kind: "client", client: clientOf("c-zed") });
});

test("with a projects list shown, text matching neither is unknown and names both kinds", () => {
  const r = pickTarget("nothing", ctx(projectsList, "c-acme"));
  assert.deepEqual(r, { kind: "unknown", message: 'no project of Acme Corp or client matches "nothing"' });
});

test("a project of another client or an inactive project is never selectable from the projects context", () => {
  // p-zweb belongs to Zed; "zweb" is not a project of Acme and matches no client
  assert.equal(pickTarget("zweb", ctx(projectsList, "c-acme")).kind, "unknown");
  assert.equal(pickTarget("retired", ctx(projectsList, "c-acme")).kind, "unknown");
  // a stale projects list entry (inactive, or of another client) is refused
  const stale: SessionList = { kind: "projects", ids: ["p-dead", "p-zweb", "gone"] };
  for (const arg of ["1", "2", "3"]) {
    const r = pickTarget(arg, ctx(stale, "c-acme"));
    assert.equal(r.kind, "unknown", arg);
    assert.match((r as { message: string }).message, /no longer available/, arg);
  }
});

test("a projects list whose session client is no longer active is refused", () => {
  const r = pickTarget("1", ctx(projectsList, "c-old"));
  assert.equal(r.kind, "unknown");
  assert.match((r as { message: string }).message, /last list shown was projects, not clients|no longer available/);
});

test("client and project together, by code, by name and mixed", () => {
  assert.deepEqual(pickBoth(["acme", "web"], ctx(none)), { kind: "both", client: clientOf("c-acme"), project: projectOf("p-web") });
  assert.deepEqual(pickBoth(["Zed", "Studio", "Zed", "Web"], ctx(none)), { kind: "both", client: clientOf("c-zed"), project: projectOf("p-zweb") });
  assert.deepEqual(pickBoth(["acme", "gateway"], ctx(none)), { kind: "both", client: clientOf("c-acme"), project: projectOf("p-api") });
});

test("a client given as a number uses the clients list; the project part is never a number", () => {
  assert.deepEqual(pickBoth(["1", "web"], ctx(clientsList)), { kind: "both", client: clientOf("c-acme"), project: projectOf("p-web") });
  const r = pickBoth(["acme", "2"], ctx(clientsList));
  assert.equal(r.kind, "unknown");
  assert.match((r as { message: string }).message, /project.*code or name/);
});

test("a project of another client is rejected and says whose it is", () => {
  const r = pickBoth(["acme", "zweb"], ctx(none));
  assert.equal(r.kind, "unknown");
  assert.match((r as { message: string }).message, /Zed Web belongs to Zed Studio, not Acme Corp/);
});

test("an inactive project or unknown project of the client is rejected", () => {
  assert.equal(pickBoth(["acme", "retired"], ctx(none)).kind, "unknown");
  const r = pickBoth(["acme", "nothing"], ctx(none));
  assert.deepEqual(r, { kind: "unknown", message: 'no project of Acme Corp matches "nothing"' });
});

test("an ambiguous project within the client is reported with its candidates", () => {
  const r = pickBoth(["acme", "api"], ctx(none));
  assert.equal(r.kind, "ambiguous");
  assert.equal((r as { of: string }).of, "projects");
  assert.deepEqual((r as { candidates: Project[] }).candidates.map((p) => p.id), ["p-app", "p-api"]);
});

test("an ambiguous client in the two-argument form is reported, never guessed", () => {
  const r = pickBoth(["corp", "web"], ctx(none));
  assert.equal(r.kind, "ambiguous");
  assert.equal((r as { of: string }).of, "clients");
});

test("two arguments that name no client are unknown, and one argument is not a pair", () => {
  assert.equal(pickBoth(["nothing", "web"], ctx(none)).kind, "unknown");
  assert.equal(pickBoth(["acme"], ctx(none)).kind, "unknown");
});

test("the task link is kept when the linked task belongs to the resulting project", () => {
  assert.deepEqual(taskLinkOutcome({ hubTaskId: "t-web", hubTaskTitle: "Fix login" }, TASKS, { id: "p-web", name: "Web" }), { keep: true, message: "task link kept" });
});

test("the task link is dropped, with the reason, when the task is in another project", () => {
  assert.deepEqual(taskLinkOutcome({ hubTaskId: "t-api", hubTaskTitle: "Ship endpoint" }, TASKS, { id: "p-web", name: "Web" }), {
    keep: false, message: "task link dropped (Ship endpoint is not in Web)",
  });
});

test("the task link is dropped when the task is gone from the catalog or there is no project", () => {
  assert.deepEqual(taskLinkOutcome({ hubTaskId: "t-gone", hubTaskTitle: "Old one" }, TASKS, { id: "p-web", name: "Web" }), {
    keep: false, message: "task link dropped (Old one is not in Web)",
  });
  assert.deepEqual(taskLinkOutcome({ hubTaskId: "t-web", hubTaskTitle: "Fix login" }, TASKS, undefined), {
    keep: false, message: "task link dropped (Fix login needs a project)",
  });
  // without a stored title the id is named
  assert.deepEqual(taskLinkOutcome({ hubTaskId: "t-gone" }, TASKS, undefined), { keep: false, message: "task link dropped (t-gone needs a project)" });
});

test("without a link there is nothing to say", () => {
  assert.equal(taskLinkOutcome(undefined, TASKS, { id: "p-web", name: "Web" }), undefined);
});
