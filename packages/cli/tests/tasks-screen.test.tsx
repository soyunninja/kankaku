import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { TasksScreen } from "../src/ui/tasks-screen.tsx";
import type { TaskRow, TasksModel } from "../src/domain/tasks-model.ts";
import { settle, waitFor } from "./helpers/ui-wait.ts";

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
  const { stdin, lastFrame } = render(
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
  await settle(lastFrame);
  await waitFor(() => {
    assert.deepEqual(calls, [false, true]);
  });
});

test("'r' reloads with the current all flag", async () => {
  let loadCalls = 0;
  const { stdin, lastFrame } = render(
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
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(loadCalls, 2);
  });
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
  const { stdin, lastFrame } = render(
    <TasksScreen load={() => model()} roots={["/work"]} version="0.1.0" columns={120} projectFilter="kankaku" onClearFilter={() => (cleared = true)} />,
  );
  stdin.write("\u001B");
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(cleared, true);
  });
});

test("renders at 80 columns without overflowing any line", () => {
  const { lastFrame } = render(<TasksScreen load={() => model()} roots={["/work"]} version="0.1.0" columns={80} />);
  const lines = (lastFrame() ?? "").split("\n");
  assert.ok(lines.every((line) => line.length <= 80));
});

function manyRows(count: number): TaskRow[] {
  return Array.from({ length: count }, (_, index) => row({ id: `r${index}`, project: `p${index}` }));
}

test("fits within `rows` and shows both indicators with many tasks at 100×24", async () => {
  const { lastFrame, stdin } = render(
    <TasksScreen load={() => model(manyRows(40))} roots={["/work"]} version="0.1.0" columns={100} rows={24} />,
  );
  // Move the selection into the middle of the list, so both the '↑ N more'
  // and '↓ N more' indicators are visible at once (the scenario that a
  // fixed-width column overflowing the panel's actual content width used
  // to corrupt into blank lines instead of the indicator text).
  stdin.write("\u001B[6~"); // Page Down
  await settle(lastFrame);

  await waitFor(() => {
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    assert.ok(lines.length <= 24, `expected at most 24 lines, got ${lines.length}`);
    assert.equal(/↑ \d+ more/.test(frame), true, "expected an '↑ N more' indicator");
    assert.equal(/↓ \d+ more/.test(frame), true, "expected a '↓ N more' indicator");
    // Every visible row is real task content — no blank line stands in for
    // a row that failed to render (the corruption this guards against).
    assert.equal(lines.some((line) => /^\s*$/.test(line) && line !== ""), false, "no whitespace-only line should appear inside the frame");
  });
});

test("PageDown/PageUp move the selection by the window size, Home/End jump to the ends", async () => {
  const { lastFrame, stdin } = render(
    <TasksScreen load={() => model(manyRows(40))} roots={["/work"]} version="0.1.0" columns={120} rows={24} />,
  );
  // The sidebar's own "› Tasks" marker can land on the same terminal row as
  // the table's selected line, so match the task row's own shape (time +
  // project) rather than the first "› " anywhere in the frame.
  const markedProject = (): string | undefined => (lastFrame() ?? "").match(/› \d{2}:\d{2} (p\d+)/)?.[1];

  assert.equal(markedProject(), "p0");

  stdin.write("\u001B[6~"); // Page Down
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(markedProject(), "p19");
  });

  stdin.write("\u001B[6~"); // Page Down again
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(markedProject(), "p38");
  });

  stdin.write("\u001B[5~"); // Page Up
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(markedProject(), "p19");
  });

  stdin.write("\u001B[H"); // Home
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(markedProject(), "p0");
  });

  stdin.write("\u001B[F"); // End
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(markedProject(), "p39");
  });
});

test("a 3000-character prompt never pushes the header out of view or the detail panel past its budget, at 100×24", () => {
  const longPrompt = "word ".repeat(600).trim();
  const rows = manyRows(40);
  rows[0] = { ...rows[0]!, fullPrompt: longPrompt };
  const { lastFrame } = render(
    <TasksScreen load={() => model(rows)} roots={["/work"]} version="0.1.0" columns={100} rows={24} />,
  );
  const frame = lastFrame() ?? "";
  const lines = frame.split("\n");
  assert.ok(lines.length <= 24, `expected at most 24 lines, got ${lines.length}`);
  assert.equal(lines[0]?.startsWith(">_ kankaku"), true, "line 1 should be the header");
  assert.equal(lines[lines.length - 1]?.includes("q quit"), true, "the last line should be the footer hints");
  assert.match(frame, /… \d+ more lines/, "a truncated prompt should end with a '… N more lines' indicator");
});

test("a 3000-character prompt is clipped the same way in stacked mode", () => {
  const longPrompt = "word ".repeat(600).trim();
  const rows = manyRows(40);
  rows[0] = { ...rows[0]!, fullPrompt: longPrompt };
  const { lastFrame } = render(
    <TasksScreen load={() => model(rows)} roots={["/work"]} version="0.1.0" columns={90} rows={24} />,
  );
  const frame = lastFrame() ?? "";
  const lines = frame.split("\n");
  assert.ok(lines.length <= 24, `expected at most 24 lines, got ${lines.length}`);
  assert.equal(lines[0]?.startsWith(">_ kankaku"), true, "line 1 should be the header");
  assert.equal(lines[lines.length - 1]?.includes("q quit"), true, "the last line should be the footer hints");
  assert.match(frame, /… \d+ more lines/, "a truncated prompt should end with a '… N more lines' indicator");
});
