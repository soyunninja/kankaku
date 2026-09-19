import assert from "node:assert/strict";
import { test } from "node:test";
import { pickTarget } from "../src/adapters/target-picker.ts";
import type { PickerCatalog } from "../src/adapters/target-picker.ts";
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
