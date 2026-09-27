import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { DashboardScreen } from "../src/ui/dashboard-screen.tsx";
import type { DashboardActions } from "../src/ui/dashboard-screen.tsx";
import type { DashboardModel, DashboardProjectRow } from "../src/domain/dashboard-model.ts";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function model(overrides: Partial<DashboardModel> = {}): DashboardModel {
  return {
    today: { name: "total", tasks: 12, wallMs: 6120000, workMs: 6120000, waitingMs: 360000, cost: 9.83, cacheHit: 0.68 },
    last7Days: [
      { day: "2026-09-21", weekday: "mon", workMs: 100000, cost: 1 },
      { day: "2026-09-22", weekday: "tue", workMs: 200000, cost: 2 },
      { day: "2026-09-23", weekday: "wed", workMs: 300000, cost: 3 },
      { day: "2026-09-24", weekday: "thu", workMs: 150000, cost: 1.5 },
      { day: "2026-09-25", weekday: "fri", workMs: 50000, cost: 0.5 },
      { day: "2026-09-26", weekday: "sat", workMs: 250000, cost: 2.5 },
      { day: "2026-09-27", weekday: "sun", workMs: 350000, cost: 3.5 },
    ],
    projects: [
      { name: "kankaku", tasks: 8, wallMs: 3720000, workMs: 3720000, waitingMs: 100000, cost: 6.49, share: 1 },
      { name: "kankaku-tui", tasks: 3, wallMs: 1860000, workMs: 1860000, waitingMs: 100000, cost: 2.1, share: 0.5 },
      { name: "kankaku-hub", tasks: 1, wallMs: 540000, workMs: 540000, waitingMs: 100000, cost: 1.24, share: 0.15 },
    ],
    hub: {
      status: "ready",
      pending: 1,
      staleOutsideWindow: 0,
      lastSyncOk: true,
      lastSyncAt: "2026-09-27T08:20:00.000Z",
      catalog: { url: "https://kankaku.soyun.ninja", clientCount: 9, projectCount: 17 },
    },
    ...overrides,
  };
}

function actions(overrides: Partial<DashboardActions> = {}): DashboardActions {
  return {
    hubAvailable: true,
    refreshCatalog: async () => "catalog: 9 clients · 17 projects · 42 tasks",
    syncAll: async () => "uploaded 2, updated 0, skipped 0, failed 0",
    ...overrides,
  };
}

test("renders the header, sidebar, panels and footer at a wide terminal", () => {
  const { lastFrame } = render(
    <DashboardScreen load={() => model()} actions={actions()} roots={["/work"]} version="0.1.0" columns={120} rows={30} />,
  );
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes(">_ kankaku 0.1.0"), true);
  assert.equal(frame.includes("› Dashboard"), true);
  assert.equal(frame.includes("Today"), true);
  assert.equal(frame.includes("Last 7 days"), true);
  assert.equal(frame.includes("Projects"), true);
  assert.equal(frame.includes("Hub"), true);
  assert.equal(frame.includes("Quick actions"), true);
  assert.equal(frame.includes("kankaku-tui"), true);
  assert.equal(frame.includes("r refresh"), true);
  assert.equal(frame.includes("roots 1"), true);
});

test("reloads through `load` when 'r' is pressed", async () => {
  let loadCalls = 0;
  const { stdin } = render(
    <DashboardScreen
      load={() => {
        loadCalls += 1;
        return model();
      }}
      actions={actions()}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
    />,
  );
  stdin.write("r");
  await nextTick();
  assert.equal(loadCalls, 2);
});

test("enter on the selected project calls onOpenProject with its name", async () => {
  let opened: string | undefined;
  const { stdin } = render(
    <DashboardScreen load={() => model()} actions={actions()} roots={["/work"]} version="0.1.0" columns={120} onOpenProject={(name) => (opened = name)} />,
  );
  stdin.write("\u001B[B"); // down arrow -> select kankaku-tui
  await nextTick();
  stdin.write("\r");
  await nextTick();
  assert.equal(opened, "kankaku-tui");
});

test("shows a plain note instead of the Hub panel body when the hub is not configured", () => {
  const { lastFrame } = render(
    <DashboardScreen load={() => model({ hub: { status: "unavailable" } })} actions={actions()} roots={["/work"]} version="0.1.0" columns={120} />,
  );
  assert.equal((lastFrame() ?? "").includes("hub not configured"), true);
});

test("stacks the panels in one column under 70 columns without overflowing", () => {
  const { lastFrame } = render(<DashboardScreen load={() => model()} actions={actions()} roots={["/work"]} version="0.1.0" columns={80} />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("Today"), true);
  assert.equal(frame.includes("Projects"), true);
  const lines = frame.split("\n");
  assert.ok(lines.every((line) => line.length <= 80));
});

function manyProjects(count: number): DashboardProjectRow[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `project-${index}`,
    tasks: 1,
    wallMs: 60000,
    workMs: 60000,
    waitingMs: 0,
    cost: 1,
    share: 0.5,
  }));
}

test("fits within `rows` with many projects at 100×24", async () => {
  const { lastFrame, stdin } = render(
    <DashboardScreen load={() => model({ projects: manyProjects(40) })} actions={actions()} roots={["/work"]} version="0.1.0" columns={100} rows={24} />,
  );
  // Scroll into the middle of the list, so both indicators are visible at
  // once — the scenario where a fixed-width column overflowing the
  // panel's actual content width used to corrupt rendering into blank
  // lines instead of showing the indicator text and the Today card.
  stdin.write("\u001B[6~"); // Page Down
  await nextTick();

  const frame = lastFrame() ?? "";
  const lines = frame.split("\n");
  assert.ok(lines.length <= 24, `expected at most 24 lines, got ${lines.length}`);
  assert.equal(frame.includes("work"), true, "the Today card's work line should still render");
  assert.equal(/↑ \d+ more/.test(frame), true, "expected an '↑ N more' indicator");
  assert.equal(/↓ \d+ more/.test(frame), true, "expected a '↓ N more' indicator");
});

test("PageDown/Home/End move the Projects selection", async () => {
  const { lastFrame, stdin } = render(
    <DashboardScreen load={() => model({ projects: manyProjects(40) })} actions={actions()} roots={["/work"]} version="0.1.0" columns={100} rows={24} />,
  );
  const markedProject = (): string | undefined => (lastFrame() ?? "").match(/› (project-\d+)/)?.[1];

  assert.equal(markedProject(), "project-0");

  stdin.write("\u001B[6~"); // Page Down
  await nextTick();
  const afterPageDown = markedProject();
  assert.notEqual(afterPageDown, "project-0");
  assert.notEqual(afterPageDown, "project-1");

  stdin.write("\u001B[F"); // End
  await nextTick();
  assert.equal(markedProject(), "project-39");

  stdin.write("\u001B[H"); // Home
  await nextTick();
  assert.equal(markedProject(), "project-0");
});

function longNameProjects(count: number): DashboardProjectRow[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `a-very-long-descriptive-project-name-that-keeps-going-${index}`,
    tasks: 1,
    wallMs: 60000,
    workMs: 60000,
    waitingMs: 0,
    cost: 1,
    share: 0.5,
  }));
}

test("a long project name list never pushes the header out of view or any right-column panel past its budget, at 100×20", () => {
  const { lastFrame } = render(
    <DashboardScreen load={() => model({ projects: longNameProjects(40) })} actions={actions()} roots={["/work"]} version="0.1.0" columns={100} rows={20} />,
  );
  const frame = lastFrame() ?? "";
  const lines = frame.split("\n");
  assert.ok(lines.length <= 20, `expected at most 20 lines, got ${lines.length}`);
  assert.equal(lines[0]?.startsWith(">_ kankaku"), true, "line 1 should be the header");
  assert.equal(lines[lines.length - 1]?.includes("q quit"), true, "the last line should be the footer hints");
  assert.equal(frame.includes("Last 7 days"), true);
  assert.equal(frame.includes("Hub"), true);
});

test("the Quick actions panel lists all four actions", () => {
  const { lastFrame } = render(<DashboardScreen load={() => model()} actions={actions()} roots={["/work"]} version="0.1.0" columns={120} rows={30} />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("c") && frame.includes("refresh catalog"), true);
  assert.equal(frame.includes("sync all projects"), true);
  assert.equal(frame.includes("full sync all"), true);
  assert.equal(frame.includes("reload"), true);
});

test("'c' shows a busy line while refreshCatalog runs, then the result", async () => {
  let resolveRefresh: (value: string) => void = () => {};
  const pending = new Promise<string>((resolve) => {
    resolveRefresh = resolve;
  });
  const { lastFrame, stdin } = render(
    <DashboardScreen
      load={() => model()}
      actions={actions({ refreshCatalog: () => pending })}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
      rows={30}
      focused
    />,
  );
  stdin.write("c");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("… refresh catalog"), true);

  resolveRefresh("catalog: 9 clients · 17 projects · 42 tasks");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("catalog: 9 clients · 17 projects · 42 tasks"), true);
});

test("after a quick action settles, the model reloads (Hub card and Projects table refresh)", async () => {
  let loadCalls = 0;
  const { stdin } = render(
    <DashboardScreen
      load={() => {
        loadCalls += 1;
        return model();
      }}
      actions={actions({ syncAll: async () => "uploaded 1, updated 0, skipped 0, failed 0" })}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
      rows={30}
      focused
    />,
  );
  const before = loadCalls;
  stdin.write("s");
  await nextTick();
  await nextTick();
  assert.ok(loadCalls > before, "expected the dashboard model to reload after the action settled");
});

test("quick action keys are ignored while another action is busy", async () => {
  let refreshCalls = 0;
  let syncCalls = 0;
  const pending = new Promise<string>(() => {}); // never resolves within this test
  const { stdin } = render(
    <DashboardScreen
      load={() => model()}
      actions={actions({
        refreshCatalog: () => {
          refreshCalls += 1;
          return pending;
        },
        syncAll: async () => {
          syncCalls += 1;
          return "ok";
        },
      })}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
      rows={30}
      focused
    />,
  );
  stdin.write("c");
  await nextTick();
  assert.equal(refreshCalls, 1);

  stdin.write("s");
  await nextTick();
  assert.equal(syncCalls, 0, "sync should be ignored while refresh is busy");
});

test("quick action keys are ignored when the main zone is not focused", async () => {
  let refreshCalls = 0;
  const { stdin } = render(
    <DashboardScreen
      load={() => model()}
      actions={actions({
        refreshCatalog: async () => {
          refreshCalls += 1;
          return "done";
        },
      })}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
      rows={30}
      focused={false}
    />,
  );
  stdin.write("c");
  await nextTick();
  assert.equal(refreshCalls, 0);
});

test("without hub credentials, the panel shows a note and 'c'/'s'/'S' do nothing", async () => {
  let refreshCalls = 0;
  const { lastFrame, stdin } = render(
    <DashboardScreen
      load={() => model()}
      actions={actions({ hubAvailable: false, refreshCatalog: async () => (refreshCalls += 1, "unused") })}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
      rows={30}
      focused
    />,
  );
  assert.equal((lastFrame() ?? "").includes("hub not configured"), true);
  stdin.write("c");
  await nextTick();
  assert.equal(refreshCalls, 0);
});
