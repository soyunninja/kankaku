import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { TasksScreen } from "../src/ui/tasks-screen.tsx";
import type { TasksModel } from "../src/domain/tasks-model.ts";

function model(): TasksModel {
  return {
    rows: [
      { id: "t1", time: "09:00", project: "alpha", clientName: "Acme", hubTaskTitle: "Fix checkout", wallMs: 60000, workMs: 60000, cost: 1.5, prompt: "first task" },
      { id: "t2", time: "10:00", project: "beta", wallMs: 30000, workMs: 20000, cost: 0.2, prompt: "second task" },
    ],
  };
}

test("TasksScreen renders the title, both rows and the footer", () => {
  const calls: Array<{ all: boolean }> = [];
  const { lastFrame } = render(
    <TasksScreen
      load={(options) => {
        calls.push(options);
        return model();
      }}
    />,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, />_ kankaku · Tasks/);
  assert.match(frame, /alpha/);
  assert.match(frame, /beta/);
  assert.match(frame, /Acme/);
  assert.match(frame, /Fix checkout/);
  assert.match(frame, /a today\/all · ↑↓ select · r refresh/);
  assert.deepEqual(calls, [{ all: false }]);
});

test("TasksScreen shows the empty state when there are no rows", () => {
  const { lastFrame } = render(<TasksScreen load={() => ({ rows: [] })} />);
  assert.match(lastFrame() ?? "", /no tasks/);
});

test("TasksScreen toggles all/today on 'a' and reloads with the new flag", () => {
  const calls: Array<{ all: boolean }> = [];
  const { stdin } = render(
    <TasksScreen
      load={(options) => {
        calls.push(options);
        return model();
      }}
    />,
  );
  stdin.write("a");
  assert.deepEqual(calls, [{ all: false }, { all: true }]);
  stdin.write("a");
  assert.deepEqual(calls, [{ all: false }, { all: true }, { all: false }]);
});

test("TasksScreen reloads on 'r' with the current all/today flag", () => {
  const calls: Array<{ all: boolean }> = [];
  const { stdin } = render(
    <TasksScreen
      load={(options) => {
        calls.push(options);
        return model();
      }}
    />,
  );
  stdin.write("r");
  assert.deepEqual(calls, [{ all: false }, { all: false }]);
});

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

test("TasksScreen moves the selection with arrow keys and highlights the selected row", async () => {
  const { lastFrame, stdin } = render(<TasksScreen load={() => model()} />);
  const before = lastFrame() ?? "";
  stdin.write("\u001B[B"); // down arrow
  await nextTick();
  const after = lastFrame() ?? "";
  assert.notEqual(before, after);
  assert.match(after, /› 10:00 {2}beta/);
});
