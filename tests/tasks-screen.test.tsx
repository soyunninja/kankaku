import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { TasksScreen } from "../src/ui/tasks-screen.tsx";
import type { TaskRow, TasksModel } from "../src/domain/tasks-model.ts";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function row(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: overrides.id ?? "r1",
    time: "09:00",
    project: "kankaku",
    wallMs: 60000,
    workMs: 55000,
    waitingMs: 5000,
    cost: 1.5,
    cacheHit: 0.6,
    subagentCount: 0,
    prompt: "short prompt",
    fullPrompt: "short prompt",
    ...overrides,
  };
}

function model(rows: TaskRow[] = [row()]): TasksModel {
  return { rows };
}

test("renders the table and the detail panel for the selected row", () => {
  const { lastFrame } = render(<TasksScreen load={() => model()} roots={["/work"]} version="0.1.0" columns={120} />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("Tasks"), true);
  assert.equal(frame.includes("Task"), true);
  assert.equal(frame.includes("kankaku"), true);
  assert.equal(frame.includes("short prompt"), true);
});

test("'a' toggles today/all and reloads", async () => {
  const calls: boolean[] = [];
  const { stdin } = render(
    <TasksScreen
      load={(options) => {
        calls.push(options.all);
        return model();
      }}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
    />,
  );
  stdin.write("a");
  await nextTick();
  assert.deepEqual(calls, [false, true]);
});

test("'r' reloads with the current all flag", async () => {
  let loadCalls = 0;
  const { stdin } = render(
    <TasksScreen
      load={() => {
        loadCalls += 1;
        return model();
      }}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
    />,
  );
  stdin.write("r");
  await nextTick();
  assert.equal(loadCalls, 2);
});

test("filters rows to projectFilter and shows it in the header", () => {
  const rows = [row({ id: "a", project: "kankaku" }), row({ id: "b", project: "kankaku-tui" })];
  const { lastFrame } = render(
    <TasksScreen load={() => model(rows)} roots={["/work"]} version="0.1.0" columns={120} projectFilter="kankaku-tui" />,
  );
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("kankaku-tui"), true);
  assert.equal(frame.includes("filtered"), true);
});

test("esc clears the project filter", async () => {
  let cleared = false;
  const { stdin } = render(
    <TasksScreen load={() => model()} roots={["/work"]} version="0.1.0" columns={120} projectFilter="kankaku" onClearFilter={() => (cleared = true)} />,
  );
  stdin.write("\u001B");
  await nextTick();
  assert.equal(cleared, true);
});

test("renders at 80 columns without overflowing any line", () => {
  const { lastFrame } = render(<TasksScreen load={() => model()} roots={["/work"]} version="0.1.0" columns={80} />);
  const lines = (lastFrame() ?? "").split("\n");
  assert.ok(lines.every((line) => line.length <= 80));
});
