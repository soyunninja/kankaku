import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { App } from "../src/ui/app.tsx";
import type { DashboardModel } from "../src/domain/dashboard-model.ts";
import type { TasksModel } from "../src/domain/tasks-model.ts";
import type { CatalogModel } from "../src/domain/catalog-model.ts";
import type { SyncModel } from "../src/ui/sync-screen.tsx";

function dashboardModel(): DashboardModel {
  return {
    today: { name: "total", tasks: 0, wallMs: 0, workMs: 0, waitingMs: 0, cost: 0 },
    last7Days: [],
    projects: [{ name: "kankaku-tui", tasks: 1, wallMs: 60000, workMs: 60000, waitingMs: 0, cost: 1, share: 1 }],
    hub: { status: "unavailable" },
  };
}

function tasksModel(): TasksModel {
  return { rows: [] };
}

function catalogModel(): CatalogModel {
  return { status: "unavailable" };
}

function syncModel(): SyncModel {
  return { status: "unavailable", reason: "hub credentials are not configured" };
}

function appProps() {
  return {
    roots: ["/work"],
    version: "0.1.0",
    loadToday: () => dashboardModel(),
    loadTasks: () => tasksModel(),
    catalog: { load: () => catalogModel(), refresh: async () => catalogModel() },
    sync: { load: () => syncModel(), syncOne: async () => ({ ok: true as const, message: "" }), syncAll: async () => [] },
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

test("App renders the sidebar with Today active by default", () => {
  const { lastFrame } = render(<App {...appProps()} />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("› Today"), true);
  assert.equal(frame.includes(">_ kankaku 0.1.0"), true);
});

test("App switches screens on 1-4", async () => {
  const { lastFrame, stdin } = render(<App {...appProps()} />);
  stdin.write("2");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("› Tasks"), true);
  stdin.write("3");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("› Catalog"), true);
  stdin.write("4");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("› Sync"), true);
  stdin.write("1");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("› Today"), true);
});

test("enter on a Today project opens Tasks filtered to it", async () => {
  const { lastFrame, stdin } = render(<App {...appProps()} />);
  stdin.write("\r");
  await nextTick();
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("› Tasks"), true);
  assert.equal(frame.includes("filtered: kankaku-tui"), true);
});
