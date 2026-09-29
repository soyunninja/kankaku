import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client, HubTask, Project } from "kankaku-pi/domain";
import type { HubRowSnapshot, ReassignCatalog, ReassignTarget } from "../src/domain/reassign-model.ts";
import {
  advance,
  back,
  finishApplying,
  jumpSelection,
  moveSelection,
  openPicker,
  pickerHeading,
  pickerHints,
  pickerOptions,
  pickerRows,
  pickerTitle,
} from "../src/domain/reassign-picker.ts";
import type { PickerState } from "../src/domain/reassign-picker.ts";

const clients: Client[] = [
  { id: "c-sin", name: "Sin determinar", code: "SIN", active: true, unassigned: true },
  { id: "c-acme", name: "Acme", code: "ACM", active: true },
  { id: "c-old", name: "Old Co", code: "OLD", active: false },
  { id: "c-beta", name: "Beta", code: "BET", active: true },
];
const projects: Project[] = [
  { id: "p-web", name: "Website", clientId: "c-acme", repoPaths: [], active: true },
  { id: "p-dead", name: "Retired", clientId: "c-acme", repoPaths: [], active: false },
  { id: "p-api", name: "API", clientId: "c-acme", repoPaths: [], active: true },
  { id: "p-beta", name: "Beta site", clientId: "c-beta", repoPaths: [], active: true },
];
const tasks: HubTask[] = [
  { id: "h-login", title: "Fix login", projectId: "p-web", status: "open" },
  { id: "h-done", title: "Shipped", projectId: "p-web", status: "done" },
  { id: "h-menu", title: "Menu", projectId: "p-web", status: "doing" },
  { id: "h-rest", title: "Rate limit", projectId: "p-api", status: "open" },
];
const catalog: ReassignCatalog = { clients, projects, tasks };

function row(taskId: string, overrides: Partial<HubRowSnapshot> = {}): HubRowSnapshot {
  return { rowId: `row-${taskId}`, taskId, clientId: "c-sin", projectId: "", hubTaskId: "", ...overrides };
}

function open(mode: "single" | "bulk" = "single", targets: ReassignTarget[] = [{ taskId: "t1", label: "fix the login" }], rows: HubRowSnapshot[] = [row("t1")]): PickerState {
  return openPicker({ mode, catalog, targets, rows: new Map(rows.map((entry) => [entry.taskId, entry])) });
}

function must(state: PickerState | undefined): PickerState {
  assert.ok(state !== undefined, "expected the picker to stay open");
  return state;
}

function labels(state: PickerState): string[] {
  return pickerOptions(state).map((option) => option.label);
}

function pick(state: PickerState, label: string): PickerState {
  const index = labels(state).indexOf(label);
  assert.ok(index >= 0, `no option "${label}" in ${JSON.stringify(labels(state))}`);
  return must(advance({ ...state, index }));
}

test("opens on the client step with the first option selected", () => {
  const state = open();
  assert.equal(state.step, "client");
  assert.equal(state.index, 0);
});

test("client options are the active clients in catalog order with the unassigned client last, labelled 'unassigned'", () => {
  assert.deepEqual(labels(open()), ["Acme", "Beta", "unassigned"]);
});

test("project options are the active projects of the chosen client plus 'no project' last", () => {
  const state = pick(open(), "Acme");
  assert.equal(state.step, "project");
  assert.deepEqual(labels(state), ["Website", "API", "no project"]);
});

test("the unassigned client offers only 'no project'", () => {
  const state = pick(open(), "unassigned");
  assert.deepEqual(labels(state), ["no project"]);
});

test("task options are the non-done tasks of the chosen project plus 'no task' last", () => {
  const state = pick(pick(open(), "Acme"), "Website");
  assert.equal(state.step, "task");
  assert.deepEqual(labels(state), ["Fix login", "Menu", "no task"]);
});

test("choosing 'no project' skips the task step and goes straight to review", () => {
  const state = pick(pick(open(), "Acme"), "no project");
  assert.equal(state.step, "review");
  assert.equal(state.plan?.ok, true);
});

test("choosing a task goes to review with a plan carrying the exact payload", () => {
  const state = pick(pick(pick(open(), "Acme"), "Website"), "Fix login");
  assert.equal(state.step, "review");
  assert.ok(state.plan?.ok);
  if (!state.plan?.ok) return;
  const line = state.plan.plan.lines[0];
  assert.equal(line?.kind === "reassign" && line.payload.task, "h-login");
});

test("choosing 'no task' reviews a project-level assignment with an empty task", () => {
  const state = pick(pick(pick(open(), "Acme"), "Website"), "no task");
  assert.ok(state.plan?.ok);
  if (!state.plan?.ok) return;
  const line = state.plan.plan.lines[0];
  assert.deepEqual(line?.kind === "reassign" && line.payload, { client: "c-acme", project: "p-web", task: "" });
});

test("selection moves without wrapping and clamps at both ends", () => {
  let state = open();
  state = moveSelection(state, -1);
  assert.equal(state.index, 0);
  state = moveSelection(state, 1);
  assert.equal(state.index, 1);
  state = moveSelection(state, 10);
  assert.equal(state.index, 2);
  state = moveSelection(state, 1);
  assert.equal(state.index, 2);
  assert.equal(jumpSelection(state, "first").index, 0);
  assert.equal(jumpSelection(state, "last").index, 2);
});

test("advance uses the selected option and resets the selection for the next step", () => {
  const state = must(advance({ ...open(), index: 1 }));
  assert.equal(state.step, "project");
  assert.equal(state.index, 0);
  assert.deepEqual(labels(state), ["Beta site", "no project"]);
});

test("back from the first step closes the picker", () => {
  assert.equal(back(open()), undefined);
});

test("back walks project -> client and restores the previously chosen client", () => {
  const atProject = pick(open(), "Beta");
  const state = must(back(atProject));
  assert.equal(state.step, "client");
  assert.equal(labels(state)[state.index], "Beta");
  assert.equal(state.clientId, undefined);
});

test("back from task returns to project with the chosen project selected", () => {
  const atTask = pick(pick(open(), "Acme"), "API");
  const state = must(back(atTask));
  assert.equal(state.step, "project");
  assert.equal(labels(state)[state.index], "API");
  assert.equal(state.projectId, undefined);
});

test("back from review returns to task when a project was chosen, else to project", () => {
  const viaTask = pick(pick(pick(open(), "Acme"), "Website"), "Menu");
  const toTask = must(back(viaTask));
  assert.equal(toTask.step, "task");
  assert.equal(labels(toTask)[toTask.index], "Menu");
  assert.equal(toTask.plan, undefined);

  const viaProject = pick(pick(open(), "Acme"), "no project");
  const toProject = must(back(viaProject));
  assert.equal(toProject.step, "project");
  assert.equal(labels(toProject)[toProject.index], "no project");
});

test("advance from review moves to applying when there is something to change", () => {
  const review = pick(pick(open(), "Acme"), "no project");
  const applying = must(advance(review));
  assert.equal(applying.step, "applying");
});

test("advance from review with nothing to change goes straight to the result", () => {
  const already = open("single", [{ taskId: "t1", label: "x" }], [row("t1", { clientId: "c-acme" })]);
  const review = pick(pick(already, "Acme"), "no project");
  const result = must(advance(review));
  assert.equal(result.step, "result");
  assert.deepEqual(result.outcomes, []);
});

test("advance and back are inert while applying", () => {
  const applying = must(advance(pick(pick(open(), "Acme"), "no project")));
  assert.deepEqual(advance(applying), applying);
  assert.deepEqual(back(applying), applying);
});

test("finishApplying stores the outcomes and shows the result; advance and back then close", () => {
  const applying = must(advance(pick(pick(open(), "Acme"), "no project")));
  const done = finishApplying(applying, [{ taskId: "t1", status: "reassigned" }]);
  assert.equal(done.step, "result");
  assert.equal(advance(done), undefined);
  assert.equal(back(done), undefined);
});

test("advance on an empty option list stays where it is", () => {
  const empty = openPicker({ mode: "single", catalog: { clients: [], projects: [], tasks: [] }, targets: [{ taskId: "t1", label: "x" }], rows: new Map() });
  assert.deepEqual(pickerOptions(empty), []);
  assert.deepEqual(advance(empty), empty);
});

test("review lists one line per changed row with names, and groups what is not touched", () => {
  const rows = [row("t1"), row("t2", { clientId: "c-beta" }), row("t3", { clientId: "c-beta" })];
  const targets = [
    { taskId: "t1", label: "first" },
    { taskId: "t2", label: "second" },
    { taskId: "t3", label: "third" },
    { taskId: "t4", label: "fourth" },
  ];
  const state = pick(pick(open("bulk", targets, rows), "Acme"), "no project");
  const lines = pickerRows(state).map((entry) => entry.text);
  assert.deepEqual(lines, [
    "unassigned → Acme · first",
    "2 not touched — already assigned",
    "1 not touched — not on the hub yet — sync first",
  ]);
  const [headline, detail] = pickerHeading(state);
  assert.equal(headline, "Move 1 task to Acme");
  assert.equal(detail, "3 not touched");
});

test("review of a rejected plan says so and offers no apply", () => {
  const broken = { ...pick(pick(open(), "Acme"), "no project"), plan: { ok: false as const, error: "unknown client" } };
  assert.deepEqual(pickerRows(broken).map((entry) => entry.text), ["cannot reassign: unknown client"]);
  assert.equal(advance(broken)?.step, "review");
  assert.deepEqual(pickerHints(broken).map((hint) => hint.key), ["esc"]);
});

test("result lines report reassigned, unchanged and failed rows plus the grouped skips", () => {
  const rows = [row("t1"), row("t2"), row("t3", { clientId: "c-acme" })];
  const targets = [
    { taskId: "t1", label: "one" },
    { taskId: "t2", label: "two" },
    { taskId: "t3", label: "three" },
  ];
  const review = pick(pick(open("bulk", targets, rows), "Acme"), "no project");
  const applying = must(advance(review));
  const done = finishApplying(applying, [
    { taskId: "t1", status: "reassigned" },
    { taskId: "t2", status: "failed", reason: "the hub answered 403" },
  ]);
  assert.deepEqual(pickerRows(done).map((entry) => entry.text), [
    "reassigned · one",
    "failed: the hub answered 403 · two",
    "1 not touched — already assigned",
  ]);
  assert.equal(pickerRows(done)[1]?.tone, "error");
  const [headline] = pickerHeading(done);
  assert.equal(headline, "1 reassigned · 1 failed");
});

test("result marks a row already on the destination as unchanged", () => {
  const already = open("single", [{ taskId: "t1", label: "x" }], [row("t1", { clientId: "c-acme" })]);
  const done = must(advance(pick(pick(already, "Acme"), "no project")));
  assert.deepEqual(pickerRows(done).map((entry) => entry.text), ["unchanged · x"]);
  assert.equal(pickerHeading(done)[0], "1 unchanged");
});

test("titles and hints follow the step", () => {
  const client = open();
  assert.equal(pickerTitle(client), "Reassign · Client");
  assert.deepEqual(pickerHints(client), [
    { key: "↑↓", label: "move" },
    { key: "enter", label: "next" },
    { key: "esc", label: "close" },
  ]);
  const project = pick(client, "Acme");
  assert.equal(pickerTitle(project), "Reassign · Project");
  assert.deepEqual(pickerHints(project), [
    { key: "↑↓", label: "move" },
    { key: "enter", label: "next" },
    { key: "esc", label: "back" },
  ]);
  assert.equal(pickerTitle(pick(project, "Website")), "Reassign · Task");
  const review = pick(project, "no project");
  assert.equal(pickerTitle(review), "Reassign · Review");
  assert.deepEqual(pickerHints(review), [
    { key: "↑↓", label: "scroll" },
    { key: "enter", label: "apply" },
    { key: "esc", label: "back" },
  ]);
  const applying = must(advance(review));
  assert.equal(pickerTitle(applying), "Reassign · Applying");
  assert.equal(pickerHints(applying).length, 1);
  const done = finishApplying(applying, [{ taskId: "t1", status: "reassigned" }]);
  assert.equal(pickerTitle(done), "Reassign · Result");
  assert.deepEqual(pickerHints(done), [
    { key: "↑↓", label: "scroll" },
    { key: "enter", label: "done" },
    { key: "esc", label: "done" },
  ]);
});

test("headings name the subject: the task for one, the count of unassigned rows for bulk", () => {
  assert.deepEqual(pickerHeading(open()), ['Reassign "fix the login"', "Choose a client"]);
  const bulk = open("bulk", [{ taskId: "t1", label: "a" }, { taskId: "t2", label: "b" }, { taskId: "t3", label: "c" }], [row("t1"), row("t2"), row("t3", { clientId: "c-acme" })]);
  assert.deepEqual(pickerHeading(bulk), ["Reassign 2 unassigned tasks", "Choose a client"]);
  const atProject = pick(bulk, "Acme");
  assert.deepEqual(pickerHeading(atProject), ["Reassign 2 unassigned tasks", "Acme — choose a project"]);
  const atTask = pick(atProject, "Website");
  assert.deepEqual(pickerHeading(atTask), ["Reassign 2 unassigned tasks", "Acme · Website — choose a task"]);
});

test("selection index is clamped when a step changes to a shorter list", () => {
  const state = must(advance({ ...open(), index: 2 }));
  assert.equal(state.index, 0);
});
