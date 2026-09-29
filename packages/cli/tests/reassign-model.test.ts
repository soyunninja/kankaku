import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client, HubTask, Project } from "kankaku-pi/domain";
import {
  ALREADY_ASSIGNED,
  NOT_ON_HUB,
  describeAssignment,
  eligibleForBulk,
  planReassignment,
} from "../src/domain/reassign-model.ts";
import type { HubRowSnapshot, ReassignCatalog, ReassignTarget } from "../src/domain/reassign-model.ts";

const clients: Client[] = [
  { id: "c-acme", name: "Acme", code: "ACM", active: true },
  { id: "c-beta", name: "Beta", code: "BET", active: true },
  { id: "c-old", name: "Old Co", code: "OLD", active: false },
  { id: "c-sin", name: "Sin determinar", code: "SIN", active: true, unassigned: true },
];

const projects: Project[] = [
  { id: "p-web", name: "Website", clientId: "c-acme", repoPaths: [], active: true },
  { id: "p-api", name: "API", clientId: "c-acme", repoPaths: [], active: true },
  { id: "p-dead", name: "Retired", clientId: "c-acme", repoPaths: [], active: false },
  { id: "p-beta", name: "Beta site", clientId: "c-beta", repoPaths: [], active: true },
];

const tasks: HubTask[] = [
  { id: "h-login", title: "Fix login", projectId: "p-web", status: "open" },
  { id: "h-menu", title: "Menu", projectId: "p-web", status: "doing" },
  { id: "h-done", title: "Shipped", projectId: "p-web", status: "done" },
  { id: "h-rest", title: "Rate limit", projectId: "p-api", status: "open" },
];

const catalog: ReassignCatalog = { clients, projects, tasks };

function row(taskId: string, overrides: Partial<HubRowSnapshot> = {}): HubRowSnapshot {
  return { rowId: `row-${taskId}`, taskId, clientId: "c-sin", projectId: "", hubTaskId: "", ...overrides };
}

function rowsOf(...list: HubRowSnapshot[]): Map<string, HubRowSnapshot> {
  return new Map(list.map((entry) => [entry.taskId, entry]));
}

function target(taskId: string, label = `prompt ${taskId}`): ReassignTarget {
  return { taskId, label };
}

function plan(input: Partial<Parameters<typeof planReassignment>[0]> & Pick<Parameters<typeof planReassignment>[0], "selection">) {
  return planReassignment({ rows: rowsOf(row("t1")), tasks: [target("t1")], catalog, mode: "single", ...input });
}

function okPlan(result: ReturnType<typeof planReassignment>) {
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) throw new Error("unreachable");
  return result.plan;
}

test("a full client/project/task selection reassigns an unassigned row with names and the exact relation payload", () => {
  const result = okPlan(plan({ selection: { clientId: "c-acme", projectId: "p-web", hubTaskId: "h-login" } }));
  assert.equal(result.mode, "single");
  assert.equal(result.destination, "Acme · Website › Fix login");
  assert.deepEqual(result.lines, [
    {
      kind: "reassign",
      taskId: "t1",
      label: "prompt t1",
      rowId: "row-t1",
      from: "unassigned",
      to: "Acme · Website › Fix login",
      payload: { client: "c-acme", project: "p-web", task: "h-login" },
    },
  ]);
});

test("a client-only selection sends empty strings for the project and the task", () => {
  const result = okPlan(plan({ selection: { clientId: "c-acme" } }));
  const line = result.lines[0];
  assert.equal(line?.kind, "reassign");
  if (line?.kind !== "reassign") return;
  assert.deepEqual(line.payload, { client: "c-acme", project: "", task: "" });
  assert.equal(line.to, "Acme");
});

test("a client and project without a task sends an empty task", () => {
  const result = okPlan(plan({ selection: { clientId: "c-acme", projectId: "p-api" } }));
  const line = result.lines[0];
  assert.equal(line?.kind === "reassign" && line.payload.task, "");
  assert.equal(line?.kind === "reassign" && line.to, "Acme · API");
});

test("reassigning to the unassigned client is allowed and is described as 'unassigned'", () => {
  const rows = rowsOf(row("t1", { clientId: "c-acme", projectId: "p-web", hubTaskId: "h-login" }));
  const result = okPlan(plan({ rows, selection: { clientId: "c-sin" } }));
  const line = result.lines[0];
  assert.equal(line?.kind, "reassign");
  if (line?.kind !== "reassign") return;
  assert.equal(line.from, "Acme · Website › Fix login");
  assert.equal(line.to, "unassigned");
  assert.deepEqual(line.payload, { client: "c-sin", project: "", task: "" });
});

test("a row that already has exactly that assignment is unchanged", () => {
  const rows = rowsOf(row("t1", { clientId: "c-acme", projectId: "p-web", hubTaskId: "h-login" }));
  const result = okPlan(plan({ rows, selection: { clientId: "c-acme", projectId: "p-web", hubTaskId: "h-login" } }));
  assert.deepEqual(result.lines, [{ kind: "unchanged", taskId: "t1", label: "prompt t1", at: "Acme · Website › Fix login" }]);
});

test("a row with the same client but a different project is a reassignment", () => {
  const rows = rowsOf(row("t1", { clientId: "c-acme", projectId: "p-web", hubTaskId: "" }));
  const result = okPlan(plan({ rows, selection: { clientId: "c-acme", projectId: "p-api" } }));
  assert.equal(result.lines[0]?.kind, "reassign");
});

test("a task with no row on the hub is skipped with the sync-first reason", () => {
  const result = okPlan(plan({ rows: rowsOf(), selection: { clientId: "c-acme" } }));
  assert.deepEqual(result.lines, [{ kind: "skipped", taskId: "t1", label: "prompt t1", reason: NOT_ON_HUB }]);
  assert.equal(NOT_ON_HUB, "not on the hub yet — sync first");
});

test("bulk mode touches only rows on the unassigned client and skips the others", () => {
  const rows = rowsOf(
    row("t1"),
    row("t2", { clientId: "c-beta", projectId: "p-beta", hubTaskId: "" }),
    row("t3", { clientId: "c-sin", projectId: "", hubTaskId: "" }),
  );
  const result = okPlan(
    plan({
      rows,
      tasks: [target("t1"), target("t2"), target("t3"), target("t4")],
      selection: { clientId: "c-acme", projectId: "p-web" },
      mode: "bulk",
    }),
  );
  assert.deepEqual(
    result.lines.map((line) => [line.taskId, line.kind, line.kind === "skipped" ? line.reason : undefined]),
    [
      ["t1", "reassign", undefined],
      ["t2", "skipped", ALREADY_ASSIGNED],
      ["t3", "reassign", undefined],
      ["t4", "skipped", NOT_ON_HUB],
    ],
  );
  assert.equal(ALREADY_ASSIGNED, "already assigned");
});

test("single mode may reassign a row that is already assigned to something else", () => {
  const rows = rowsOf(row("t1", { clientId: "c-beta", projectId: "p-beta", hubTaskId: "" }));
  const result = okPlan(plan({ rows, selection: { clientId: "c-acme" } }));
  const line = result.lines[0];
  assert.equal(line?.kind === "reassign" && line.from, "Beta · Beta site");
});

test("bulk mode with the unassigned client as destination reports unassigned rows as unchanged", () => {
  const result = okPlan(plan({ mode: "bulk", selection: { clientId: "c-sin" } }));
  assert.equal(result.lines[0]?.kind, "unchanged");
});

test("a row whose relations are no longer in the catalog is described without ids", () => {
  const rows = rowsOf(row("t1", { clientId: "c-gone", projectId: "p-gone", hubTaskId: "h-gone" }));
  const result = okPlan(plan({ rows, selection: { clientId: "c-acme" } }));
  const line = result.lines[0];
  assert.equal(line?.kind === "reassign" && line.from, "unknown client · unknown project › unknown task");
});

test("a row with no client at all reads as no client", () => {
  const rows = rowsOf(row("t1", { clientId: "" }));
  const result = okPlan(plan({ rows, selection: { clientId: "c-acme" } }));
  const line = result.lines[0];
  assert.equal(line?.kind === "reassign" && line.from, "no client");
});

const rejections: Array<[string, { clientId: string; projectId?: string; hubTaskId?: string }, string]> = [
  ["unknown client", { clientId: "c-nope" }, "unknown client"],
  ["inactive client", { clientId: "c-old" }, 'client "Old Co" is not active'],
  ["unknown project", { clientId: "c-acme", projectId: "p-nope" }, "unknown project"],
  ["inactive project", { clientId: "c-acme", projectId: "p-dead" }, 'project "Retired" is not active'],
  ["project of another client", { clientId: "c-acme", projectId: "p-beta" }, 'project "Beta site" does not belong to client "Acme"'],
  ["project under the unassigned client", { clientId: "c-sin", projectId: "p-web" }, 'project "Website" does not belong to client "Sin determinar"'],
  ["task without a project", { clientId: "c-acme", hubTaskId: "h-login" }, "a task needs a project"],
  ["unknown task", { clientId: "c-acme", projectId: "p-web", hubTaskId: "h-nope" }, "unknown task"],
  ["task of another project", { clientId: "c-acme", projectId: "p-api", hubTaskId: "h-login" }, 'task "Fix login" does not belong to project "API"'],
  ["done task", { clientId: "c-acme", projectId: "p-web", hubTaskId: "h-done" }, 'task "Shipped" is done'],
];

for (const [name, selection, message] of rejections) {
  test(`an inconsistent selection is rejected as a whole: ${name}`, () => {
    const result = plan({ selection });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, message);
    assert.equal("plan" in result, false, "a rejected selection never carries a plan or payload");
  });
}

test("a rejection happens even when there are no rows to touch", () => {
  const result = plan({ rows: rowsOf(), tasks: [], selection: { clientId: "c-nope" } });
  assert.equal(result.ok, false);
});

test("empty-string project and task ids read as absent", () => {
  const result = okPlan(plan({ selection: { clientId: "c-acme", projectId: "", hubTaskId: "" } }));
  const line = result.lines[0];
  assert.equal(line?.kind === "reassign" && line.payload.project, "");
});

test("describeAssignment joins client, project and task with the app's separators", () => {
  assert.equal(describeAssignment({ clientId: "c-acme", projectId: "", hubTaskId: "" }, catalog), "Acme");
  assert.equal(describeAssignment({ clientId: "c-acme", projectId: "p-web", hubTaskId: "" }, catalog), "Acme · Website");
  assert.equal(describeAssignment({ clientId: "c-acme", projectId: "p-web", hubTaskId: "h-menu" }, catalog), "Acme · Website › Menu");
  assert.equal(describeAssignment({ clientId: "c-sin", projectId: "", hubTaskId: "" }, catalog), "unassigned");
});

test("eligibleForBulk keeps only targets whose hub row is on the unassigned client", () => {
  const rows = rowsOf(row("t1"), row("t2", { clientId: "c-acme" }));
  const eligible = eligibleForBulk([target("t1"), target("t2"), target("t3")], rows, catalog);
  assert.deepEqual(eligible.map((entry) => entry.taskId), ["t1"]);
});

test("eligibleForBulk is empty when the catalog has no unassigned client", () => {
  const withoutSin: ReassignCatalog = { ...catalog, clients: clients.filter((client) => client.unassigned !== true) };
  assert.deepEqual(eligibleForBulk([target("t1")], rowsOf(row("t1")), withoutSin), []);
});
