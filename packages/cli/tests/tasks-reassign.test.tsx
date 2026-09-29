import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import type { Client, HubTask, Project } from "kankaku-pi/domain";
import { TasksScreen } from "../src/ui/tasks-screen.tsx";
import type { TaskRow, TasksModel } from "../src/domain/tasks-model.ts";
import type { HubRowSnapshot, ReassignCatalog, ReassignPlan, RowOutcome } from "../src/domain/reassign-model.ts";
import type { ReassignActions, ReassignPrepared } from "../src/ports/reassign-actions.ts";

const ENTER = "\r";
const ESC = "\u001B";
const DOWN = "\u001B[B";
const PAGE_DOWN = "\u001B[6~";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 80));
}

function row(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    time: "09:00",
    project: "kankaku",
    wallMs: 60000,
    workMs: 55000,
    waitingMs: 5000,
    cost: 1.5,
    subagentCount: 0,
    prompt: `prompt of ${id}`,
    fullPrompt: `prompt of ${id}`,
    ...overrides,
  };
}

const clients: Client[] = [
  { id: "c-acme", name: "Acme", code: "ACM", active: true },
  { id: "c-sin", name: "Sin determinar", code: "SIN", active: true, unassigned: true },
];
const projects: Project[] = [{ id: "p-web", name: "Website", clientId: "c-acme", repoPaths: [], active: true }];
const hubTasks: HubTask[] = [{ id: "h-login", title: "Fix login", projectId: "p-web", status: "open" }];
const catalog: ReassignCatalog = { clients, projects, tasks: hubTasks };

function hubRow(taskId: string, overrides: Partial<HubRowSnapshot> = {}): HubRowSnapshot {
  return { rowId: `row-${taskId}`, taskId, clientId: "c-sin", projectId: "", hubTaskId: "", ...overrides };
}

interface Fake extends ReassignActions {
  prepared: string[][];
  applied: ReassignPlan[];
}

function fake(options: {
  rows?: HubRowSnapshot[];
  catalog?: ReassignCatalog;
  prepare?: () => Promise<ReassignPrepared>;
  apply?: (plan: ReassignPlan) => Promise<RowOutcome[]>;
} = {}): Fake {
  const rows = options.rows ?? [hubRow("t1")];
  const actions: Fake = {
    prepared: [],
    applied: [],
    async prepare(taskIds) {
      actions.prepared.push(taskIds);
      if (options.prepare) return options.prepare();
      return { ok: true, catalog: options.catalog ?? catalog, rows: new Map(rows.filter((entry) => taskIds.includes(entry.taskId)).map((entry) => [entry.taskId, entry])) };
    },
    async apply(plan) {
      actions.applied.push(plan);
      if (options.apply) return options.apply(plan);
      return plan.lines.filter((line) => line.kind === "reassign").map((line) => ({ taskId: line.taskId, status: "reassigned" as const }));
    },
  };
  return actions;
}

function mount(props: { rows?: TaskRow[]; actions?: ReassignActions | undefined; screenRows?: number; focused?: boolean; onModalChange?: (open: boolean) => void; onClearFilter?: () => void; load?: () => TasksModel }) {
  const model: TasksModel = { rows: props.rows ?? [row("t1")] };
  return render(
    <TasksScreen
      load={props.load ?? (() => model)}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
      rows={props.screenRows ?? 24}
      focused={props.focused ?? true}
      {...(props.actions !== undefined ? { reassign: props.actions } : {})}
      {...(props.onModalChange ? { onModalChange: props.onModalChange } : {})}
      {...(props.onClearFilter ? { onClearFilter: props.onClearFilter } : {})}
    />,
  );
}

async function press(stdin: { write: (data: string) => void }, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    stdin.write(key);
    await tick();
  }
}

function frameOf(lastFrame: () => string | undefined): string {
  return lastFrame() ?? "";
}

function footer(lastFrame: () => string | undefined): string {
  const lines = frameOf(lastFrame).split("\n");
  return lines[lines.length - 1] ?? "";
}

test("'m' asks the hub for the selected task's row and opens the picker on the client step", async () => {
  const actions = fake();
  const { stdin, lastFrame } = mount({ actions });
  await press(stdin, "m");
  assert.deepEqual(actions.prepared, [["t1"]]);
  const frame = frameOf(lastFrame);
  assert.match(frame, /Reassign · Client/);
  assert.match(frame, /Reassign "prompt of t1"/);
  assert.match(frame, /› Acme/);
  assert.match(frame, /unassigned/);
  assert.match(footer(lastFrame), /↑↓ move\s+enter next\s+esc close/);
});

test("while the hub is queried the footer shows a progress message, then the picker opens", async () => {
  let release: (value: ReassignPrepared) => void = () => undefined;
  const actions = fake({ prepare: () => new Promise<ReassignPrepared>((resolve) => (release = resolve)) });
  const { stdin, lastFrame } = mount({ actions });
  await press(stdin, "m");
  assert.match(footer(lastFrame), /asking the hub/);
  assert.doesNotMatch(frameOf(lastFrame), /Reassign · Client/);
  release({ ok: true, catalog, rows: new Map([["t1", hubRow("t1")]]) });
  await tick();
  assert.match(frameOf(lastFrame), /Reassign · Client/);
});

test("walks client, project and task, reviews with names, applies and shows the result", async () => {
  const actions = fake();
  const { stdin, lastFrame } = mount({ actions });
  await press(stdin, "m", ENTER); // client Acme
  assert.match(frameOf(lastFrame), /Reassign · Project/);
  assert.match(frameOf(lastFrame), /Acme — choose a project/);
  await press(stdin, ENTER); // project Website
  assert.match(frameOf(lastFrame), /Reassign · Task/);
  assert.match(frameOf(lastFrame), /Fix login/);
  await press(stdin, ENTER); // task Fix login
  let frame = frameOf(lastFrame);
  assert.match(frame, /Reassign · Review/);
  assert.match(frame, /Move 1 task to Acme · Website › Fix login/);
  assert.match(frame, /unassigned → Acme · Website › Fix login · prompt of t1/);
  assert.match(footer(lastFrame), /enter apply/);
  assert.equal(actions.applied.length, 0);

  await press(stdin, ENTER);
  assert.equal(actions.applied.length, 1);
  assert.deepEqual(actions.applied[0]?.lines[0] && "payload" in actions.applied[0].lines[0] ? actions.applied[0].lines[0].payload : undefined, {
    client: "c-acme",
    project: "p-web",
    task: "h-login",
  });
  frame = frameOf(lastFrame);
  assert.match(frame, /Reassign · Result/);
  assert.match(frame, /1 reassigned/);
  assert.match(frame, /reassigned · prompt of t1/);

  await press(stdin, ENTER);
  frame = frameOf(lastFrame);
  assert.doesNotMatch(frame, /Reassign · /);
  assert.match(frame, /hub +Acme · Website › Fix login/);
});

test("the applying step shows while the requests are in flight and ignores keys", async () => {
  let finish: (outcomes: RowOutcome[]) => void = () => undefined;
  const actions = fake({ apply: () => new Promise<RowOutcome[]>((resolve) => (finish = resolve)) });
  const { stdin, lastFrame } = mount({ actions });
  await press(stdin, "m", ENTER, ENTER, ENTER, ENTER);
  assert.match(frameOf(lastFrame), /Reassign · Applying/);
  await press(stdin, ESC, ENTER);
  assert.match(frameOf(lastFrame), /Reassign · Applying/);
  finish([{ taskId: "t1", status: "reassigned" }]);
  await tick();
  assert.match(frameOf(lastFrame), /Reassign · Result/);
});

test("'no project' skips the task step and reviews a client-only assignment", async () => {
  const actions = fake();
  const { stdin, lastFrame } = mount({ actions });
  await press(stdin, "m", ENTER, DOWN, ENTER); // Acme, then 'no project'
  const frame = frameOf(lastFrame);
  assert.match(frame, /Reassign · Review/);
  assert.match(frame, /Move 1 task to Acme/);
});

test("esc goes back one step at a time and closes at the first", async () => {
  const modal: boolean[] = [];
  const { stdin, lastFrame } = mount({ actions: fake(), onModalChange: (open) => modal.push(open) });
  await press(stdin, "m", ENTER, ENTER); // at task
  assert.match(frameOf(lastFrame), /Reassign · Task/);
  await press(stdin, ESC);
  assert.match(frameOf(lastFrame), /Reassign · Project/);
  await press(stdin, "\u001B[D"); // left arrow also goes back
  assert.match(frameOf(lastFrame), /Reassign · Client/);
  await press(stdin, ESC);
  assert.doesNotMatch(frameOf(lastFrame), /Reassign · /);
  assert.equal(modal[modal.length - 1], false);
  assert.equal(modal.includes(true), true);
});

test("back from review returns to the task step with the previous choice selected", async () => {
  const { stdin, lastFrame } = mount({ actions: fake() });
  await press(stdin, "m", ENTER, ENTER, ENTER); // review
  await press(stdin, ESC);
  const frame = frameOf(lastFrame);
  assert.match(frame, /Reassign · Task/);
  assert.match(frame, /› Fix login/);
});

test("existing keys are inert while the picker is open: r, a, t, esc-to-clear-filter and the table selection", async () => {
  let loads = 0;
  let cleared = 0;
  const actions = fake();
  const { stdin, lastFrame } = mount({
    actions,
    rows: [row("t1"), row("t2")],
    load: () => {
      loads += 1;
      return { rows: [row("t1"), row("t2")] };
    },
    onClearFilter: () => (cleared += 1),
  });
  await press(stdin, "m");
  assert.equal(loads, 1);
  await press(stdin, "r", "a", "t", "m", "M");
  assert.equal(loads, 1, "r and a must not reload while the picker is open");
  assert.equal(actions.prepared.length, 1, "m and M must not open a second picker");
  await press(stdin, DOWN);
  assert.match(frameOf(lastFrame), /› unassigned/, "the arrow moves the picker selection");
  await press(stdin, ESC);
  assert.doesNotMatch(frameOf(lastFrame), /Reassign · /, "esc closes the picker at its first step");
  assert.equal(cleared, 0, "esc goes back or closes the picker instead of clearing the filter");
});

test("with the picker closed the screen's own keys keep working: r reloads, arrows move, esc clears the filter", async () => {
  let loads = 0;
  let cleared = 0;
  const { stdin, lastFrame } = mount({
    actions: fake(),
    load: () => {
      loads += 1;
      return { rows: [row("t1"), row("t2")] };
    },
    onClearFilter: () => (cleared += 1),
  });
  await press(stdin, "r");
  assert.equal(loads, 2);
  await press(stdin, DOWN);
  assert.match(frameOf(lastFrame), /› 09:00 kankaku/);
  await press(stdin, ESC);
  assert.equal(cleared, 1);
});

test("'M' offers only the unassigned rows of the view and reports what it will not touch", async () => {
  const actions = fake({
    rows: [hubRow("t1"), hubRow("t2", { clientId: "c-acme" }), hubRow("t4")],
  });
  const { stdin, lastFrame } = mount({ actions, rows: [row("t1"), row("t2"), row("t3"), row("t4")] });
  await press(stdin, "M");
  assert.deepEqual(actions.prepared, [["t1", "t2", "t3", "t4"]]);
  assert.match(frameOf(lastFrame), /Reassign 2 unassigned tasks/);
  await press(stdin, ENTER, DOWN, ENTER); // Acme, no project
  const frame = frameOf(lastFrame);
  assert.match(frame, /Move 2 tasks to Acme/);
  assert.match(frame, /1 not touched — already assigned/);
  assert.match(frame, /1 not touched — not on the hub yet — sync first/);
  await press(stdin, ENTER);
  assert.equal(actions.applied[0]?.lines.filter((line) => line.kind === "reassign").length, 2);
  assert.match(frameOf(lastFrame), /2 reassigned/);
});

test("'M' respects the project filter: only the filtered rows are asked about", async () => {
  const actions = fake();
  const rows = [row("t1", { project: "one" }), row("t2", { project: "two" })];
  const { stdin } = mount({ actions, rows });
  // Rendered without a filter here; the filtered case is covered through the prop below.
  void stdin;
  const filtered = fake();
  const view = render(<TasksScreen load={() => ({ rows })} roots={["/work"]} version="0.1.0" columns={120} rows={24} projectFilter="two" reassign={filtered} />);
  await press(view.stdin, "M");
  assert.deepEqual(filtered.prepared, [["t2"]]);
});

test("'M' with nothing unassigned on the hub shows a footer message and opens nothing", async () => {
  const actions = fake({ rows: [hubRow("t1", { clientId: "c-acme" })] });
  const { stdin, lastFrame } = mount({ actions });
  await press(stdin, "M");
  assert.match(footer(lastFrame), /no unassigned tasks on the hub in this view/);
  assert.doesNotMatch(frameOf(lastFrame), /Reassign · /);
});

test("'m' on a task that is not on the hub yet says to sync first and opens nothing", async () => {
  const actions = fake({ rows: [] });
  const { stdin, lastFrame } = mount({ actions });
  await press(stdin, "m");
  assert.match(footer(lastFrame), /not on the hub yet — sync first/);
  assert.doesNotMatch(frameOf(lastFrame), /Reassign · /);
});

test("the footer message clears on the next key press", async () => {
  const actions = fake({ rows: [] });
  const { stdin, lastFrame } = mount({ actions });
  await press(stdin, "m");
  assert.match(footer(lastFrame), /sync first/);
  await press(stdin, "r");
  assert.match(footer(lastFrame), /select/);
});

test("with no hub configured the reason shows in the footer and nothing opens", async () => {
  const noHub: ReassignActions = {
    prepare: async () => ({ ok: false, message: "hub credentials are not configured" }),
    apply: async () => [],
  };
  const modal: boolean[] = [];
  const { stdin, lastFrame } = mount({ actions: noHub, onModalChange: (open) => modal.push(open) });
  await press(stdin, "m");
  assert.match(footer(lastFrame), /hub credentials are not configured/);
  assert.doesNotMatch(frameOf(lastFrame), /Reassign · /);
  assert.equal(modal[modal.length - 1] ?? false, false);
});

test("a screen rendered without reassignment actions says the hub is not available", async () => {
  const { stdin, lastFrame } = mount({ actions: undefined });
  await press(stdin, "m");
  assert.match(footer(lastFrame), /reassignment is not available/);
});

test("rejected credentials show as a footer message", async () => {
  const actions = fake({ prepare: async () => ({ ok: false, message: "the hub rejected the credentials" }) });
  const { stdin, lastFrame } = mount({ actions });
  await press(stdin, "m");
  assert.match(footer(lastFrame), /the hub rejected the credentials/);
});

test("a row that fails is reported and does not hide the others", async () => {
  const actions = fake({
    rows: [hubRow("t1"), hubRow("t2")],
    apply: async () => [
      { taskId: "t1", status: "reassigned" },
      { taskId: "t2", status: "failed", reason: "not allowed to change this row (403)" },
    ],
  });
  const { stdin, lastFrame } = mount({ actions, rows: [row("t1"), row("t2")] });
  await press(stdin, "M", ENTER, DOWN, ENTER, ENTER); // Acme, no project, apply
  const frame = frameOf(lastFrame);
  assert.match(frame, /1 reassigned · 1 failed/);
  assert.match(frame, /reassigned · prompt of t1/);
  assert.match(frame, /failed: not allowed to change this row \(403\) · prompt of t2/);
});

test("after a result the list shows the hub's assignment next to the local one, only for rows asked about", async () => {
  const actions = fake();
  const { stdin, lastFrame } = mount({ actions, rows: [row("t1", { clientName: "Local Client" }), row("t2")] });
  await press(stdin, "m", ENTER, ENTER, ENTER, ENTER, ENTER);
  let frame = frameOf(lastFrame);
  assert.match(frame, /client +Local Client/);
  assert.match(frame, /hub +Acme · Website › Fix login/);
  await press(stdin, DOWN);
  frame = frameOf(lastFrame);
  assert.doesNotMatch(frame, /hub +Acme/);
});

test("a task whose hub row was only asked about shows the hub's current assignment", async () => {
  const actions = fake({ rows: [hubRow("t1", { clientId: "c-acme", projectId: "p-web" })] });
  const { stdin, lastFrame } = mount({ actions });
  await press(stdin, "m", ESC);
  assert.match(frameOf(lastFrame), /hub +Acme · Website/);
});

test("the sidebar focus rule holds: with the main zone unfocused, m and M do nothing", async () => {
  const actions = fake();
  const { stdin } = mount({ actions, focused: false });
  await press(stdin, "m", "M");
  assert.equal(actions.prepared.length, 0);
});

function manyClients(count: number): ReassignCatalog {
  return {
    clients: Array.from({ length: count }, (_, index) => ({ id: `c${index}`, name: `Client ${String(index).padStart(2, "0")}`, code: `C${index}`, active: true })).concat([
      { id: "c-sin", name: "Sin determinar", code: "SIN", active: true, unassigned: true } as Client & { id: string },
    ]) as Client[],
    projects: [],
    tasks: [],
  };
}

test("a long client list scrolls inside the panel and the frame never grows past the terminal rows", async () => {
  const actions = fake({ catalog: manyClients(60) });
  const { stdin, lastFrame } = mount({ actions, screenRows: 24 });
  await press(stdin, "m");
  let lines = frameOf(lastFrame).split("\n");
  assert.equal(lines.length, 24, "the frame has exactly the terminal's rows");
  assert.match(lines[0] ?? "", /^>_ kankaku/);
  assert.match(frameOf(lastFrame), /↓ \d+ more/);

  await press(stdin, PAGE_DOWN);
  lines = frameOf(lastFrame).split("\n");
  assert.equal(lines.length, 24);
  assert.match(lines[0] ?? "", /^>_ kankaku/, "the header never scrolls away");
  assert.match(frameOf(lastFrame), /↑ \d+ more/);
  assert.match(frameOf(lastFrame), /↓ \d+ more/);

  await press(stdin, "\u001B[F"); // End
  lines = frameOf(lastFrame).split("\n");
  assert.equal(lines.length, 24);
  assert.match(frameOf(lastFrame), /› unassigned/, "the unassigned client is last");
  assert.match(footer(lastFrame), /esc close/);
});

test("a long review list scrolls too and keeps the frame at the terminal rows", async () => {
  const many = Array.from({ length: 50 }, (_, index) => `t${index}`);
  const actions = fake({ rows: many.map((id) => hubRow(id)) });
  const { stdin, lastFrame } = mount({ actions, rows: many.map((id) => row(id)), screenRows: 24 });
  await press(stdin, "M", ENTER, DOWN, ENTER);
  assert.match(frameOf(lastFrame), /Move 50 tasks to Acme/);
  let lines = frameOf(lastFrame).split("\n");
  assert.equal(lines.length, 24);
  assert.match(frameOf(lastFrame), /↓ \d+ more/);
  await press(stdin, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN);
  lines = frameOf(lastFrame).split("\n");
  assert.equal(lines.length, 24);
  assert.match(lines[0] ?? "", /^>_ kankaku/);
});

test("the picker keeps the frame at the terminal rows on a small terminal", async () => {
  const actions = fake({ catalog: manyClients(10) });
  const { stdin, lastFrame } = mount({ actions, screenRows: 12 });
  await press(stdin, "m");
  const lines = frameOf(lastFrame).split("\n");
  assert.equal(lines.length, 12);
  assert.match(lines[0] ?? "", /^>_ kankaku/);
});

test("the footer lists the reassignment keys on one line, and 'esc clear filter' only while a filter is set", () => {
  const plain = mount({ actions: fake() });
  const line = footer(plain.lastFrame);
  assert.match(line, /a today\/all\s+m move\s+M move all/);
  assert.doesNotMatch(line, /clear filter/);
  assert.doesNotMatch(line, /\bt /);
  assert.match(line, /q quit\s+← menu/);

  const filtered = render(<TasksScreen load={() => ({ rows: [row("t1")] })} roots={["/work"]} version="0.1.0" columns={120} rows={24} projectFilter="kankaku" reassign={fake()} />);
  assert.match(footer(filtered.lastFrame), /esc clear filter/);
});

test("the picker fits a stacked 90-column terminal too", async () => {
  const actions = fake({ catalog: manyClients(30) });
  const { stdin, lastFrame } = render(<TasksScreen load={() => ({ rows: [row("t1")] })} roots={["/work"]} version="0.1.0" columns={90} rows={24} reassign={actions} />);
  await press(stdin, "m");
  const lines = frameOf(lastFrame).split("\n");
  assert.equal(lines.length, 24);
  assert.match(frameOf(lastFrame), /Reassign · Client/);
  assert.ok(lines.every((line) => line.length <= 90));
  assert.match(lines[lines.length - 1] ?? "", /esc close/);
});

test("a key pressed while the hub is being asked keeps the progress message on the footer", async () => {
  let release: (value: ReassignPrepared) => void = () => undefined;
  const actions = fake({ prepare: () => new Promise<ReassignPrepared>((resolve) => (release = resolve)) });
  const { stdin, lastFrame } = mount({ actions });
  await press(stdin, "m", "r", "t");
  assert.match(footer(lastFrame), /asking the hub/);
  release({ ok: true, catalog, rows: new Map([["t1", hubRow("t1")]]) });
  await tick();
  assert.match(frameOf(lastFrame), /Reassign · Client/);
});

test("'t' does nothing on the Tasks screen", async () => {
  let loads = 0;
  const actions = fake();
  const { stdin, lastFrame } = mount({
    actions,
    load: () => {
      loads += 1;
      return { rows: [row("t1")] };
    },
  });
  await press(stdin, "t");
  assert.equal(loads, 1);
  assert.equal(actions.prepared.length, 0);
  assert.doesNotMatch(frameOf(lastFrame), /Reassign · /);
});

test("'a' still toggles today/all while 'm' opens the picker", async () => {
  const scopes: boolean[] = [];
  const actions = fake();
  const { stdin, lastFrame } = mount({
    actions,
    load: (options?: { all: boolean }) => {
      scopes.push(options?.all ?? false);
      return { rows: [row("t1")] };
    },
  } as never);
  await press(stdin, "a");
  assert.deepEqual(scopes, [false, true]);
  assert.equal(actions.prepared.length, 0);
  assert.doesNotMatch(frameOf(lastFrame), /Reassign · /);
  await press(stdin, "m");
  assert.equal(actions.prepared.length, 1);
  assert.match(frameOf(lastFrame), /Reassign · Client/);
});
