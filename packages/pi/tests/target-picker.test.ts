import assert from "node:assert/strict";
import { test } from "node:test";
import { pickHubTask, pickTarget } from "../src/adapters/target-picker.ts";
import type { PickerCatalog } from "../src/adapters/target-picker.ts";
import type { HubTask } from "../src/domain/work-target.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function makeCtx(responses: Array<string | undefined>): { ctx: ExtensionContext; calls: Array<{ title: string; options: string[] }> } {
  const calls: Array<{ title: string; options: string[] }> = [];
  let index = 0;
  const ctx = {
    ui: {
      select: async (title: string, options: string[]) => {
        calls.push({ title, options });
        return responses[index++];
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, calls };
}

const CATALOG: PickerCatalog = {
  clients: [
    { id: "c-acme", name: "Acme", code: "acme", active: true },
    { id: "c-globex", name: "Globex", code: "globex", active: true },
    { id: "c-inactive", name: "Old Co", code: "old", active: false },
    { id: "c-unassigned", name: "Sin determinar", code: "unassigned", active: true, unassigned: true },
  ],
  projects: [
    { id: "p-portal", name: "Portal", code: "portal", clientId: "c-acme", repoPaths: [], active: true },
    { id: "p-api", name: "API", clientId: "c-acme", repoPaths: [], active: true },
    { id: "p-old", name: "Old", clientId: "c-acme", repoPaths: [], active: false },
    { id: "p-globex-a", name: "Site", clientId: "c-globex", repoPaths: [], active: true },
  ],
};

test("the client options exclude inactive and unassigned clients, sorted by name", async () => {
  const { ctx, calls } = makeCtx(["Acme", "(no project)"]);
  await pickTarget(ctx, CATALOG);

  assert.deepEqual(calls[0]?.options, ["Acme", "Globex", "— skip —"]);
});

test("picking a client and '(no project)' returns a target with no project", async () => {
  const { ctx } = makeCtx(["Acme", "(no project)"]);
  const result = await pickTarget(ctx, CATALOG);

  assert.deepEqual(result, { kind: "picked", target: { clientId: "c-acme", clientCode: "acme", clientName: "Acme" } });
});

test("picking a client and a project returns a target with both", async () => {
  const { ctx } = makeCtx(["Acme", "Portal"]);
  const result = await pickTarget(ctx, CATALOG);

  assert.deepEqual(result, {
    kind: "picked",
    target: { clientId: "c-acme", clientCode: "acme", clientName: "Acme", projectId: "p-portal", projectCode: "portal", projectName: "Portal" },
  });
});

test("the project options only include active projects of the chosen client", async () => {
  const { ctx, calls } = makeCtx(["Acme", "(no project)"]);
  await pickTarget(ctx, CATALOG);

  assert.deepEqual(calls[1]?.options, ["API", "Portal", "(no project)", "— skip —"]);
});

test("choosing '— skip —' at the client step skips the whole pick", async () => {
  const { ctx, calls } = makeCtx(["— skip —"]);
  const result = await pickTarget(ctx, CATALOG);

  assert.deepEqual(result, { kind: "skipped" });
  assert.equal(calls.length, 1, "the project dialog is never shown once the client step is skipped");
});

test("dismissing the client dialog (undefined) skips the whole pick", async () => {
  const { ctx } = makeCtx([undefined]);
  const result = await pickTarget(ctx, CATALOG);

  assert.deepEqual(result, { kind: "skipped" });
});

test("choosing '— skip —' at the project step skips the whole pick, not just the project", async () => {
  const { ctx } = makeCtx(["Acme", "— skip —"]);
  const result = await pickTarget(ctx, CATALOG);

  assert.deepEqual(result, { kind: "skipped" });
});

test("dismissing the project dialog (undefined) skips the whole pick", async () => {
  const { ctx } = makeCtx(["Acme", undefined]);
  const result = await pickTarget(ctx, CATALOG);

  assert.deepEqual(result, { kind: "skipped" });
});

test("colliding client names are disambiguated with their code", async () => {
  const catalog: PickerCatalog = {
    clients: [
      { id: "c1", name: "Acme", code: "acme-es", active: true },
      { id: "c2", name: "Acme", code: "acme-us", active: true },
    ],
    projects: [],
  };
  const { ctx, calls } = makeCtx(["Acme (acme-us)", "(no project)"]);
  const result = await pickTarget(ctx, catalog);

  assert.deepEqual(calls[0]?.options, ["Acme (acme-es)", "Acme (acme-us)", "— skip —"]);
  assert.deepEqual(result, { kind: "picked", target: { clientId: "c2", clientCode: "acme-us", clientName: "Acme" } });
});

const PORTAL_TASKS: HubTask[] = [
  { id: "t-open", title: "Fix the thing", projectId: "p-portal", status: "open" },
  { id: "t-doing", title: "Ship it", projectId: "p-portal", status: "doing" },
  { id: "t-done", title: "Old and done", projectId: "p-portal", status: "done" },
  { id: "t-other-project", title: "Belongs elsewhere", projectId: "p-api", status: "open" },
];

test("pickHubTask lists only open/doing tasks of the given project, sorted by title, plus skip", async () => {
  const { ctx, calls } = makeCtx(["— skip —"]);
  await pickHubTask(ctx, PORTAL_TASKS, "p-portal");

  assert.deepEqual(calls[0]?.options, ["Fix the thing", "Ship it", "— skip —"]);
});

test("pickHubTask returns the picked task", async () => {
  const { ctx } = makeCtx(["Ship it"]);
  const result = await pickHubTask(ctx, PORTAL_TASKS, "p-portal");

  assert.deepEqual(result, { kind: "picked", task: PORTAL_TASKS[1] });
});

test("pickHubTask returns skipped when '— skip —' is chosen or the dialog is dismissed", async () => {
  const skipped = await pickHubTask(makeCtx(["— skip —"]).ctx, PORTAL_TASKS, "p-portal");
  assert.deepEqual(skipped, { kind: "skipped" });

  const dismissed = await pickHubTask(makeCtx([undefined]).ctx, PORTAL_TASKS, "p-portal");
  assert.deepEqual(dismissed, { kind: "skipped" });
});

test("pickHubTask returns empty (without prompting) when the project has no open/doing tasks", async () => {
  const { ctx, calls } = makeCtx([]);
  const result = await pickHubTask(ctx, PORTAL_TASKS, "p-empty");

  assert.deepEqual(result, { kind: "empty" });
  assert.equal(calls.length, 0);
});

test("pickHubTask disambiguates colliding titles with their externalRef, falling back to id", async () => {
  const tasks: HubTask[] = [
    { id: "t-1", title: "Fix", projectId: "p-portal", status: "open", externalRef: "JIRA-1" },
    { id: "t-2", title: "Fix", projectId: "p-portal", status: "open", externalRef: "JIRA-2" },
    { id: "t-3", title: "Ship", projectId: "p-portal", status: "open" },
    { id: "t-4", title: "Ship", projectId: "p-portal", status: "open" },
  ];
  const { ctx, calls } = makeCtx(["— skip —"]);
  await pickHubTask(ctx, tasks, "p-portal");

  assert.deepEqual(calls[0]?.options, ["Fix (JIRA-1)", "Fix (JIRA-2)", "Ship (t-3)", "Ship (t-4)", "— skip —"]);
});
