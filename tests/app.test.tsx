import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { App } from "../src/ui/app.tsx";
import type { TodayModel } from "../src/domain/today-model.ts";
import type { TasksModel } from "../src/domain/tasks-model.ts";
import type { CatalogModel } from "../src/domain/catalog-model.ts";
import type { SyncModel } from "../src/ui/sync-screen.tsx";

function todayModel(): TodayModel {
  return { rows: [], total: { name: "total", tasks: 0, wallMs: 0, workMs: 0, waitingMs: 0, cost: 0 } };
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
    loadToday: () => todayModel(),
    loadTasks: () => tasksModel(),
    catalog: { load: () => catalogModel(), refresh: async () => catalogModel() },
    sync: { load: () => syncModel(), syncOne: async () => ({ ok: true as const, message: "" }), syncAll: async () => [] },
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

test("App renders the tab bar with Today active by default", () => {
  const { lastFrame } = render(<App {...appProps()} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /1 Today/);
  assert.match(frame, /2 Tasks/);
  assert.match(frame, /3 Catalog/);
  assert.match(frame, /4 Sync/);
  assert.match(frame, />_ kankaku · Today/);
});

test("App switches to the Tasks screen on '2' and back to Today on '1'", async () => {
  const { lastFrame, stdin } = render(<App {...appProps()} />);
  stdin.write("2");
  await nextTick();
  assert.match(lastFrame() ?? "", /kankaku · Tasks/);
  stdin.write("1");
  await nextTick();
  assert.match(lastFrame() ?? "", /kankaku · Today/);
});

test("App switches to Catalog on '3' and Sync on '4'", async () => {
  const { lastFrame, stdin } = render(<App {...appProps()} />);
  stdin.write("3");
  await nextTick();
  assert.match(lastFrame() ?? "", /kankaku · Catalog/);
  stdin.write("4");
  await nextTick();
  assert.match(lastFrame() ?? "", /kankaku · Sync/);
});
