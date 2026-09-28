import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { SetupWizard } from "../src/ui/setup/wizard-screen.tsx";
import type { WizardActions } from "../src/ui/setup/wizard-screen.tsx";
import type { ApplyResult, WizardAction, WizardFacts, WizardState } from "../src/domain/setup-wizard.ts";
import type { AgentDetectionFacts } from "../src/domain/setup-plan.ts";

function baseAgentFacts(): AgentDetectionFacts {
  return { pi: undefined, gentleShell: undefined, claudeCode: undefined, codex: undefined, opencode: undefined };
}

function baseFacts(overrides: Partial<WizardFacts> = {}): WizardFacts {
  return {
    agentFacts: baseAgentFacts(),
    hub: { credentialsPresent: false, url: undefined, email: undefined, password: undefined, credentialsPath: "/home/.kankaku/credentials.json" },
    roots: { current: undefined, defaultRoots: ["/work"], path: "/home/.kankaku/tui.json" },
    homeDir: "/home",
    ...overrides,
  };
}

function fakeActions(overrides: Partial<WizardActions> = {}): {
  actions: WizardActions;
  calls: { apply: [WizardAction, WizardState][]; checkHealth: string[] };
} {
  const calls = { apply: [] as [WizardAction, WizardState][], checkHealth: [] as string[] };
  const actions: WizardActions = {
    apply: async (action, state) => {
      calls.apply.push([action, state]);
      const result: ApplyResult = { action, outcome: "wrote" };
      return result;
    },
    checkHealth: async (url) => {
      calls.checkHealth.push(url);
      return true;
    },
    ...overrides,
  };
  return { actions, calls };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

test("Agents step (first step): renders the agent facts and Esc quits the wizard", async () => {
  const { actions } = fakeActions();
  let quit = 0;
  const { lastFrame, stdin } = render(
    <SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => (quit += 1)} columns={100} rows={24} />,
  );
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("Setup · Agents"), true);
  assert.equal(frame.includes("pi"), true);

  stdin.write("\u001B");
  await nextTick();
  assert.equal(quit, 1);
});

test("Agents step: Space toggles the cursor row's selection, disabled rows never toggle", async () => {
  const facts = baseFacts({
    agentFacts: {
      ...baseAgentFacts(),
      pi: { settingsPath: "/home/.pi/agent/settings.json", packages: [] },
      codex: { configPath: "/home/.codex/config.toml" },
    },
  });
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={facts} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  assert.equal((lastFrame() ?? "").includes("Setup · Agents"), true);
  assert.equal((lastFrame() ?? "").includes("[ ] pi"), true);

  stdin.write(" ");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("[x] pi"), true);

  // codex is present but has no adapter yet; opencode isn't present at all.
  assert.equal((lastFrame() ?? "").includes("no adapter yet"), true);
  assert.equal((lastFrame() ?? "").includes("not installed"), true);
});

test("Claude step: Enter with an empty checkout shows the error and stays on the step", async () => {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write("\u001B[B"); // pi -> gentle-shell
  await nextTick();
  stdin.write("\u001B[B"); // gentle-shell -> claude-code
  await nextTick();
  stdin.write(" "); // select claude-code
  await nextTick();
  stdin.write("\r"); // agents -> claude (selected, not configured)
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("Setup · Claude"), true);

  stdin.write("\r"); // submit an empty checkout
  await nextTick();
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("Setup · Claude"), true);
  assert.equal(frame.includes("enter the kankaku-claude checkout path"), true);
});

test("Hub step (existing mode): 'c' runs the health check and shows the result", async () => {
  const facts = baseFacts({ hub: { credentialsPresent: true, url: "https://hub.example.com", email: "a@b.com", password: "s", credentialsPath: "/home/.kankaku/credentials.json" } });
  const { actions, calls } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={facts} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write("\r"); // agents -> hub (claude not selected: skipped)
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("Setup · Hub"), true);
  assert.equal((lastFrame() ?? "").includes("hub.example.com"), true);

  stdin.write("c");
  await nextTick();
  assert.deepEqual(calls.checkHealth, ["https://hub.example.com"]);
  assert.equal((lastFrame() ?? "").includes("health ok"), true);
});

test("Hub step (local mode): shows the local install URL and blocks next until owner email/password are set", async () => {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write("\r"); // agents -> hub
  await nextTick();
  stdin.write("\u001B[A"); // skip -> local (up arrow)
  await nextTick();
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("http://127.0.0.1:8090"), true);

  stdin.write("\r"); // next with empty owner email/password: blocked
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("Setup · Hub"), true);
  assert.equal((lastFrame() ?? "").includes("enter a valid email"), true);
});

test("Hub step (local mode): Tab focuses the owner email/password fields, typing fills them, Enter advances once valid", async () => {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write("\r"); // agents -> hub
  await nextTick();
  stdin.write("\u001B[A"); // skip -> local
  await nextTick();
  stdin.write("\t"); // radio -> owner email field
  await nextTick();
  stdin.write("owner@example.com");
  await nextTick();
  stdin.write("\t"); // owner email -> owner password field
  await nextTick();
  stdin.write("s3cret");
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("owner@example.com"), true);

  stdin.write("\r"); // hub -> roots
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("Setup · Roots"), true);
});

test("Review step: lists the plan's label and file, Roots step renders along the way", async () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), pi: { settingsPath: "/home/.pi/agent/settings.json", packages: [] } } });
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={facts} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write(" "); // select pi (cursor starts on the first row)
  await nextTick();
  stdin.write("\r"); // agents -> hub
  await nextTick();
  stdin.write("\r"); // hub (skip) -> roots
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("Setup · Roots"), true);

  stdin.write("\r"); // roots -> review
  await nextTick();
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("Setup · Review"), true);
  assert.equal(frame.includes("install kankaku in pi"), true);
  assert.equal(frame.includes("/home/.pi/agent/settings.json"), true);
});

test("Apply step: runs every planned action through actions.apply in order and shows results; Done -> onDone on Enter", async () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), pi: { settingsPath: "/home/.pi/agent/settings.json", packages: [] } } });
  const { actions, calls } = fakeActions();
  let done = 0;
  const { lastFrame, stdin } = render(<SetupWizard facts={facts} actions={actions} onDone={() => (done += 1)} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write(" "); // select pi
  await nextTick();
  stdin.write("\r"); // agents -> hub
  await nextTick();
  stdin.write("\r"); // hub -> roots
  await nextTick();
  stdin.write("\r"); // roots -> review
  await nextTick();
  stdin.write("\r"); // review -> apply (starts running)
  await nextTick();
  await nextTick();

  assert.equal(calls.apply.length, 2); // install-pi + write-roots (no current tui.json)
  assert.equal(calls.apply[0]?.[0].kind, "install-pi");
  assert.equal(calls.apply[1]?.[0].kind, "write-roots");
  const applyFrame = lastFrame() ?? "";
  assert.equal(applyFrame.includes("Setup · Apply"), true);
  assert.equal(applyFrame.includes("wrote"), true);

  stdin.write("\r"); // apply finished -> done
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("Setup · Done"), true);

  stdin.write("\r");
  await nextTick();
  assert.equal(done, 1);
});

// ---- R2: no sidebar, progress in the panel title ----

test("no sidebar: the panel's top border spans the full terminal width, not a reduced main width", () => {
  const { actions } = fakeActions();
  const { lastFrame } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);
  const lines = (lastFrame() ?? "").split("\n");
  const topBorder = lines.find((line) => line.includes("╭")) ?? "";
  assert.equal(topBorder.length, 100);
});

test("no sidebar: no left-hand step list with a › step marker or ✓ completed marker", () => {
  const { actions } = fakeActions();
  const { lastFrame } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("✓ Agents"), false);
  assert.equal(frame.includes("✓ Hub"), false);
});

test("title carries progress numbering: Agents 1/5 once Claude Code is selected", async () => {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write("\u001B[B"); // pi -> gentle-shell
  await nextTick();
  stdin.write("\u001B[B"); // gentle-shell -> claude-code
  await nextTick();
  stdin.write(" "); // select claude-code (not configured -> the Claude step is needed)
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("Setup · Agents 1/5"), true);
});

test("title numbers only the steps shown this run: Claude skipped drops the total to 4", async () => {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  assert.equal((lastFrame() ?? "").includes("Setup · Agents 1/4"), true);

  stdin.write("\r"); // agents -> hub (claude not selected)
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("Setup · Hub 2/4"), true);
});

test("title has no numbering on Done", async () => {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  for (let i = 0; i < 4; i += 1) {
    stdin.write("\r"); // agents -> hub -> roots -> review -> apply
    await nextTick();
  }
  await nextTick(); // let the (empty) plan's apply effect settle
  stdin.write("\r"); // apply finished -> done
  await nextTick();
  assert.equal((lastFrame() ?? "").includes("Setup · Done"), true);
  assert.equal((lastFrame() ?? "").includes("Setup · Done 5/4"), false);
});
