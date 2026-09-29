import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { SetupWizard } from "../src/ui/setup/wizard-screen.tsx";
import type { WizardActions } from "../src/ui/setup/wizard-screen.tsx";
import type { ApplyResult, WizardAction, WizardFacts, WizardState } from "../src/domain/setup-wizard.ts";
import type { AgentDetectionFacts } from "../src/domain/setup-plan.ts";
import { settle, waitFor } from "./helpers/ui-wait.ts";

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
  calls: { apply: [WizardAction, WizardState][]; checkHealth: string[]; isPortFree: number[]; suggestPort: number[] };
} {
  const calls = { apply: [] as [WizardAction, WizardState][], checkHealth: [] as string[], isPortFree: [] as number[], suggestPort: [] as number[] };
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
    isPortFree: async (port) => {
      calls.isPortFree.push(port);
      return true;
    },
    suggestPort: async (from) => {
      calls.suggestPort.push(from);
      return from;
    },
    ...overrides,
  };
  return { actions, calls };
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
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(quit, 1);
  });
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
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("[x] pi"), true);
  });

  // codex is present but has no adapter yet; opencode isn't present at all.
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("no adapter yet"), true);
    assert.equal((lastFrame() ?? "").includes("not installed"), true);
  });
});

test("Hub step (existing mode): 'c' runs the health check and shows the result", async () => {
  const facts = baseFacts({ hub: { credentialsPresent: true, url: "https://hub.example.com", email: "a@b.com", password: "s", credentialsPath: "/home/.kankaku/credentials.json" } });
  const { actions, calls } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={facts} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write("\r"); // agents -> hub (there is no separate Claude step)
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Hub"), true);
    assert.equal((lastFrame() ?? "").includes("hub.example.com"), true);
  });

  stdin.write("c");
  await settle(lastFrame);
  await waitFor(() => {
    assert.deepEqual(calls.checkHealth, ["https://hub.example.com"]);
    assert.equal((lastFrame() ?? "").includes("health ok"), true);
  });
});

test("Hub step (local mode): shows the local install URL and blocks next until owner email/password are set", async () => {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write("\r"); // agents -> hub
  await settle(lastFrame);
  stdin.write("\u001B[A"); // skip -> local (up arrow)
  await settle(lastFrame);
  await waitFor(() => {
    const frame = lastFrame() ?? "";
    assert.equal(frame.includes("http://127.0.0.1:8090"), true);
  });

  stdin.write("\r"); // next with empty owner email/password: blocked
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Hub"), true);
    assert.equal((lastFrame() ?? "").includes("enter a valid email"), true);
  });
});

test("Hub step (local mode): Tab focuses the owner email/password fields, typing fills them, Enter advances once valid", async () => {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write("\r"); // agents -> hub
  await settle(lastFrame);
  stdin.write("\u001B[A"); // skip -> local
  await settle(lastFrame);
  stdin.write("\t"); // radio -> owner email field
  await settle(lastFrame);
  stdin.write("owner@example.com");
  await settle(lastFrame);
  stdin.write("\t"); // owner email -> owner password field
  await settle(lastFrame);
  stdin.write("s3cret");
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("owner@example.com"), true);
  });

  stdin.write("\r"); // hub -> roots
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Roots"), true);
  });
});

test("Review step: lists the plan's label and file, Roots step renders along the way", async () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), pi: { settingsPath: "/home/.pi/agent/settings.json", packages: [] } } });
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={facts} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write(" "); // select pi (cursor starts on the first row)
  await settle(lastFrame);
  stdin.write("\r"); // agents -> hub
  await settle(lastFrame);
  stdin.write("\r"); // hub (skip) -> roots
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Roots"), true);
  });

  stdin.write("\r"); // roots -> review
  await settle(lastFrame);
  await waitFor(() => {
    const frame = lastFrame() ?? "";
    assert.equal(frame.includes("Setup · Review"), true);
    assert.equal(frame.includes("install kankaku in pi"), true);
    assert.equal(frame.includes("/home/.pi/agent/settings.json"), true);
  });
});

/** Moves the wizard to the Hub step in local mode with the owner fields filled, leaving focus on the radio. */
async function toLocalHub(view: { stdin: { write: (data: string) => void }; lastFrame: () => string | undefined }): Promise<void> {
  const { stdin, lastFrame } = view;
  stdin.write("\r"); // agents -> hub
  await settle(lastFrame);
  stdin.write("\u001B[A"); // skip -> local
  await settle(lastFrame);
  stdin.write("\t");
  await settle(lastFrame);
  stdin.write("owner@example.com");
  await settle(lastFrame);
  stdin.write("\t");
  await settle(lastFrame);
  stdin.write("s3cret");
  await settle(lastFrame);
}

test("Hub step (local mode): the port field is prefilled with the first free port from the default upwards", async () => {
  const asked: number[] = [];
  const { actions } = fakeActions({
    suggestPort: async (from) => {
      asked.push(from);
      return from + 3;
    },
  });
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);
  await settle(lastFrame);
  stdin.write("\r"); // agents -> hub
  await settle(lastFrame);
  stdin.write("\u001B[A"); // skip -> local
  await settle(lastFrame);

  await waitFor(() => {
    const frame = lastFrame() ?? "";
    assert.equal(frame.includes("port: 8093"), true);
    assert.equal(frame.includes("http://127.0.0.1:8093"), true);
    assert.deepEqual(asked, [8090]);
  });
});

test("Hub step (local mode): an occupied port is rejected inline and blocks next; a free one goes through", async () => {
  const taken = [8095];
  const probed: number[] = [];
  const { actions } = fakeActions({
    suggestPort: async () => 8095,
    isPortFree: async (port) => {
      probed.push(port);
      return !taken.includes(port);
    },
  });
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);
  await settle(lastFrame);
  await toLocalHub({ stdin, lastFrame });

  stdin.write("\r"); // hub -> roots: blocked, 8095 is taken
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Hub"), true);
    assert.equal((lastFrame() ?? "").includes("port 8095 is in use"), true);
  });

  stdin.write("\t"); // owner password -> port
  await settle(lastFrame);
  stdin.write("\u007F"); // backspace: 8095 -> 809
  await settle(lastFrame);
  stdin.write("6");
  await settle(lastFrame);
  await waitFor(() => assert.equal((lastFrame() ?? "").includes("port: 8096"), true)); // the edit is on screen
  assert.equal((lastFrame() ?? "").includes("port 8095 is in use"), false); // editing clears the error
  stdin.write("\r");
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Roots"), true);
    assert.deepEqual(probed, [8095, 8096]);
  });
});

test("Hub step (local mode): a port outside 1024-65535 is rejected without probing", async () => {
  const probed: number[] = [];
  const { actions } = fakeActions({
    isPortFree: async (port) => {
      probed.push(port);
      return true;
    },
  });
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);
  await settle(lastFrame);
  await toLocalHub({ stdin, lastFrame });
  stdin.write("\t"); // -> port
  await settle(lastFrame);
  for (let i = 0; i < 4; i += 1) stdin.write("\u007F");
  await settle(lastFrame);
  stdin.write("80");
  await settle(lastFrame);
  stdin.write("\r");
  await settle(lastFrame);

  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Hub"), true);
    assert.equal((lastFrame() ?? "").includes("enter a port between 1024 and 65535"), true);
    assert.deepEqual(probed, []);
  });
});

test("Hub step (local mode): an existing install keeps its own port, prefilled and never probed", async () => {
  const facts = baseFacts({ hub: { credentialsPresent: false, url: undefined, email: undefined, password: undefined, credentialsPath: "/home/.kankaku/credentials.json", localPort: 8093 } });
  const probed: number[] = [];
  const asked: number[] = [];
  const { actions } = fakeActions({
    isPortFree: async (port) => {
      probed.push(port);
      return false;
    },
    suggestPort: async (from) => {
      asked.push(from);
      return from;
    },
  });
  const { lastFrame, stdin } = render(<SetupWizard facts={facts} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);
  await settle(lastFrame);
  await toLocalHub({ stdin, lastFrame });
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("port: 8093"), true);
    assert.deepEqual(asked, []);
  });

  stdin.write("\r");
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Roots"), true);
    assert.deepEqual(probed, []);
  });
});

test("Review and apply carry the chosen port into the install action", async () => {
  const { actions, calls } = fakeActions({ suggestPort: async () => 8093 });
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={120} rows={24} />);
  await settle(lastFrame);
  await toLocalHub({ stdin, lastFrame });
  stdin.write("\r"); // hub -> roots
  await settle(lastFrame);
  stdin.write("\r"); // roots -> review
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("install a local hub at http://127.0.0.1:8093"), true);
  });

  stdin.write("\r"); // review -> apply
  await settle(lastFrame);
  await settle(lastFrame);
  const install = calls.apply.find(([action]) => action.kind === "install-local-hub");
  await waitFor(() => {
    assert.equal(install?.[0].file, "http://127.0.0.1:8093");
    assert.equal(install?.[1].hub.port, "8093");
  });
});

async function reviewWithLocalHub(facts: WizardFacts): Promise<string> {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={facts} actions={actions} onDone={() => {}} onQuit={() => {}} columns={120} rows={24} />);
  stdin.write("\r"); // agents -> hub
  await settle(lastFrame);
  stdin.write(facts.hub.credentialsPresent ? "\u001B[B" : "\u001B[A"); // existing -> local (down), or skip -> local (up)
  await settle(lastFrame);
  stdin.write("\t");
  await settle(lastFrame);
  stdin.write("owner@example.com");
  await settle(lastFrame);
  stdin.write("\t");
  await settle(lastFrame);
  stdin.write("s3cret");
  await settle(lastFrame);
  stdin.write("\r"); // hub -> roots
  await settle(lastFrame);
  stdin.write("\r"); // roots -> review
  await settle(lastFrame);
  return lastFrame() ?? "";
}

test("Review step (install locally): says the sync credentials move to the local hub when none exist", async () => {
  const frame = await reviewWithLocalHub(baseFacts());
  assert.equal(frame.includes("Setup · Review"), true);
  assert.equal(frame.includes("sync credentials → the local hub"), true);
});

test("Review step (install locally): says the sync credentials stay on the existing hub and how to switch later", async () => {
  const facts = baseFacts({ hub: { credentialsPresent: true, url: "https://hub.example.com", email: "a@b.c", password: "pw", credentialsPath: "/home/.kankaku/credentials.json" } });
  const frame = await reviewWithLocalHub(facts);
  assert.equal(frame.includes("Setup · Review"), true);
  assert.equal(frame.includes("sync credentials stay on https://hub.example.com (switch later with kankaku hub use)"), true);
});

test("Apply step: runs every planned action through actions.apply in order and shows results; Done -> onDone on Enter", async () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), pi: { settingsPath: "/home/.pi/agent/settings.json", packages: [] } } });
  const { actions, calls } = fakeActions();
  let done = 0;
  const { lastFrame, stdin } = render(<SetupWizard facts={facts} actions={actions} onDone={() => (done += 1)} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write(" "); // select pi
  await settle(lastFrame);
  stdin.write("\r"); // agents -> hub
  await settle(lastFrame);
  stdin.write("\r"); // hub -> roots
  await settle(lastFrame);
  stdin.write("\r"); // roots -> review
  await settle(lastFrame);
  stdin.write("\r"); // review -> apply (starts running)
  await settle(lastFrame);
  await settle(lastFrame);

  await waitFor(() => {
    assert.equal(calls.apply.length, 2); // install-pi + write-roots (no current tui.json)
    assert.equal(calls.apply[0]?.[0].kind, "install-pi");
    assert.equal(calls.apply[1]?.[0].kind, "write-roots");
    const applyFrame = lastFrame() ?? "";
    assert.equal(applyFrame.includes("Setup · Apply"), true);
    assert.equal(applyFrame.includes("wrote"), true);
  });

  stdin.write("\r"); // apply finished -> done
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Done"), true);
  });

  stdin.write("\r");
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(done, 1);
  });
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

test("title carries progress numbering across steps: Agents 1/4 -> Hub 2/4", async () => {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  assert.equal((lastFrame() ?? "").includes("Setup · Agents 1/4"), true);

  stdin.write("\r"); // agents -> hub
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Hub 2/4"), true);
  });
});

test("title numbering stays at 1/4 even when Claude Code is selected (no separate Claude step)", async () => {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  stdin.write("\u001B[B"); // pi -> gentle-shell
  await settle(lastFrame);
  stdin.write("\u001B[B"); // gentle-shell -> claude-code
  await settle(lastFrame);
  stdin.write(" "); // select claude-code
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Agents 1/4"), true);
  });
});

test("title has no numbering on Done", async () => {
  const { actions } = fakeActions();
  const { lastFrame, stdin } = render(<SetupWizard facts={baseFacts()} actions={actions} onDone={() => {}} onQuit={() => {}} columns={100} rows={24} />);

  for (let i = 0; i < 4; i += 1) {
    stdin.write("\r"); // agents -> hub -> roots -> review -> apply
    await settle(lastFrame);
  }
  await settle(lastFrame); // let the (empty) plan's apply effect settle
  stdin.write("\r"); // apply finished -> done
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("Setup · Done"), true);
    assert.equal((lastFrame() ?? "").includes("Setup · Done 5/4"), false);
  });
});
