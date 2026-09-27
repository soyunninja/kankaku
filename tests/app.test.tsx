import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { App } from "../src/ui/app.tsx";
import type { DashboardModel } from "../src/domain/dashboard-model.ts";
import type { TasksModel } from "../src/domain/tasks-model.ts";
import type { CatalogModel } from "../src/domain/catalog-model.ts";
import type { SyncModel } from "../src/ui/sync-screen.tsx";
import type { DashboardActions } from "../src/ui/dashboard-screen.tsx";
import type { WizardActions } from "../src/ui/setup/wizard-screen.tsx";
import type { WizardFacts } from "../src/domain/setup-wizard.ts";

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

function dashboardActions(): DashboardActions {
  return { hubAvailable: false, refreshCatalog: async () => "", syncAll: async () => "" };
}

function appProps() {
  return {
    roots: ["/work"],
    version: "0.1.0",
    loadToday: () => dashboardModel(),
    loadTasks: () => tasksModel(),
    catalog: { load: () => catalogModel(), refresh: async () => catalogModel() },
    sync: { load: () => syncModel(), syncOne: async () => ({ ok: true as const, message: "" }), syncAll: async () => [] },
    dashboardActions: dashboardActions(),
  };
}

function wizardFacts(): WizardFacts {
  return {
    agentFacts: { pi: undefined, gentleShell: undefined, claudeCode: undefined, codex: undefined, opencode: undefined },
    hub: { credentialsPresent: false, url: undefined, email: undefined, password: undefined, credentialsPath: "/home/.kankaku/credentials.json", localCheckoutGuess: "" },
    roots: { current: undefined, defaultRoots: ["/work"], path: "/home/.kankaku/tui.json" },
    homeDir: "/home",
  };
}

function wizardActions(): WizardActions {
  return {
    apply: async (action) => ({ action, outcome: "wrote" }),
    checkHealth: async () => true,
    findHubCheckout: () => undefined,
    manualCommands: () => [],
    installLocalHub: async () => ({ url: "http://127.0.0.1:8090", serviceEmail: "a@b", servicePassword: "pw" }),
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

test("App renders the sidebar with Dashboard active by default", () => {
  const { lastFrame } = render(<App {...appProps()} />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("› Dashboard"), true);
  assert.equal(frame.includes(">_ kankaku 0.1.0"), true);
});

test("the very first frame already has the sidebar focused: its own footer hints show, not the screen's", () => {
  const { lastFrame } = render(<App {...appProps()} />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("↑↓ choose"), true);
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
  assert.equal((lastFrame() ?? "").includes("› Dashboard"), true);
});

test("enter first focuses the main zone, then opens the selected Dashboard project", async () => {
  const { lastFrame, stdin } = render(<App {...appProps()} />);
  stdin.write("\r");
  await nextTick();
  // First `enter` (sidebar focused) only moves focus to main: no navigation yet.
  const afterFirstEnter = lastFrame() ?? "";
  assert.equal(afterFirstEnter.includes("filtered:"), false);
  assert.equal(afterFirstEnter.includes("› Dashboard"), true);
  assert.equal(afterFirstEnter.includes("← menu"), true);

  stdin.write("\r");
  await nextTick();
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("› Tasks"), true);
  assert.equal(frame.includes("filtered: kankaku-tui"), true);
});

test("sidebar focus: down/up move the active screen (clamped), without opening it", async () => {
  const { lastFrame, stdin } = render(<App {...appProps()} />);
  assert.equal((lastFrame() ?? "").includes("choose"), true); // sidebar-focus footer hints

  stdin.write("\u001B[A"); // up arrow, already on the first screen: clamps
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("› Dashboard"), true);

  stdin.write("\u001B[B"); // down arrow
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("› Tasks"), true);

  stdin.write("\u001B[B");
  await nextTick();
  stdin.write("\u001B[B");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("› Sync"), true);

  stdin.write("\u001B[B"); // down arrow, already on the last screen: clamps
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("› Sync"), true);
});

test("right arrow and tab, like enter, focus the main zone from the sidebar", async () => {
  for (const key of ["\u001B[C", "\t"]) {
    const { lastFrame, stdin } = render(<App {...appProps()} />);
    assert.equal((lastFrame() ?? "").includes("choose"), true);
    stdin.write(key);
    await nextTick();
    assert.equal((lastFrame() ?? "").includes("← menu"), true);
  }
});

test("left arrow and tab return focus to the sidebar from the main zone", async () => {
  for (const key of ["\u001B[D", "\t"]) {
    const { lastFrame, stdin } = render(<App {...appProps()} />);
    stdin.write("\r"); // focus main
    await nextTick();
    assert.equal((lastFrame() ?? "").includes("← menu"), true);
    stdin.write(key);
    await nextTick();
    assert.equal((lastFrame() ?? "").includes("choose"), true);
  }
});

test("digit keys switch screens without changing which zone is focused", async () => {
  const { lastFrame, stdin } = render(<App {...appProps()} />);
  stdin.write("\r"); // focus main
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("← menu"), true);

  stdin.write("2");
  await nextTick();
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("› Tasks"), true);
  assert.equal(frame.includes("← menu"), true); // still main-focused
});

test("while the sidebar is focused, arrow keys never reach the active screen's own list", async () => {
  const { lastFrame, stdin } = render(<App {...appProps()} />);
  // On Dashboard, sidebar focused by default: down arrow moves the active
  // screen (to Tasks) instead of the Projects selection.
  stdin.write("\u001B[B");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("› Tasks"), true);
});

test("esc on Tasks with a project filter clears it first, the next esc returns to the sidebar", async () => {
  const { lastFrame, stdin } = render(<App {...appProps()} />);
  stdin.write("\r"); // focus main on Dashboard
  await nextTick();
  stdin.write("\r"); // open the selected project in Tasks, filtered
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("filtered: kankaku-tui"), true);
  assert.equal((lastFrame() ?? "").includes("← menu"), true); // still main-focused

  stdin.write("\u001B"); // first esc: clears the filter, stays on Tasks, stays main-focused
  await nextTick();
  const afterFirstEsc = lastFrame() ?? "";
  assert.equal(afterFirstEsc.includes("filtered:"), false);
  assert.equal(afterFirstEsc.includes("› Tasks"), true);
  assert.equal(afterFirstEsc.includes("← menu"), true);

  stdin.write("\u001B"); // second esc: no filter left to consume, returns to the sidebar
  await nextTick();
  const afterSecondEsc = lastFrame() ?? "";
  assert.equal(afterSecondEsc.includes("choose"), true);
});

test("esc on a screen without a project filter returns straight to the sidebar", async () => {
  const { lastFrame, stdin } = render(<App {...appProps()} />);
  stdin.write("\r"); // focus main on Dashboard
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("← menu"), true);

  stdin.write("\u001B");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("choose"), true);
});

test("startInWizard opens the app straight into the setup wizard instead of the Dashboard", () => {
  const { lastFrame } = render(<App {...appProps()} wizard={{ facts: wizardFacts(), actions: wizardActions() }} startInWizard />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("Setup · Agents"), true);
  assert.equal(frame.includes("› Dashboard"), false);
});

test("without startInWizard, the app opens on the Dashboard as usual even when a wizard is supplied", () => {
  const { lastFrame } = render(<App {...appProps()} wizard={{ facts: wizardFacts(), actions: wizardActions() }} />);
  assert.equal((lastFrame() ?? "").includes("› Dashboard"), true);
});

test("finishing the wizard (Done -> Enter) switches to the Dashboard in place, reloading its data", async () => {
  let loads = 0;
  const props = appProps();
  const { lastFrame, stdin } = render(
    <App
      {...props}
      loadToday={() => {
        loads += 1;
        return dashboardModel();
      }}
      wizard={{ facts: wizardFacts(), actions: wizardActions() }}
      startInWizard
    />,
  );
  assert.equal((lastFrame() ?? "").includes("Setup · Agents"), true);
  assert.equal(loads, 0);

  for (let i = 0; i < 4; i += 1) {
    stdin.write("\r"); // agents -> hub -> roots -> review -> apply
    await nextTick();
  }
  await nextTick(); // let the (empty) plan's apply effect settle
  assert.equal((lastFrame() ?? "").includes("Setup · Apply"), true);

  stdin.write("\r"); // apply finished (empty plan) -> done
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("Setup · Done"), true);

  stdin.write("\r"); // done -> onDone
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("› Dashboard"), true);
  assert.equal(loads, 1);
});

test("while the wizard is active, the app's own global keys (q, digits, arrows) are inert", async () => {
  const { lastFrame, stdin } = render(<App {...appProps()} wizard={{ facts: wizardFacts(), actions: wizardActions() }} startInWizard />);
  stdin.write("1"); // would switch to Dashboard on the normal shell
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("Setup · Agents"), true);
});
