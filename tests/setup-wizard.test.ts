import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWizardState,
  guessClaudeCheckout,
  toggleAgent,
  setClaudeCheckout,
  setHubMode,
  setHubField,
  setHubHealth,
  setRoots,
  setLocalCheckout,
  setHubLocalManual,
  next,
  back,
  planFromWizard,
  applyResult,
  hintsForStep,
} from "../src/domain/setup-wizard.ts";
import type { WizardFacts, WizardState } from "../src/domain/setup-wizard.ts";
import type { AgentDetectionFacts } from "../src/domain/setup-plan.ts";

function baseAgentFacts(): AgentDetectionFacts {
  return { pi: undefined, gentleShell: undefined, claudeCode: undefined, codex: undefined, opencode: undefined };
}

function baseFacts(overrides: Partial<WizardFacts> = {}): WizardFacts {
  return {
    agentFacts: baseAgentFacts(),
    hub: { credentialsPresent: false, url: undefined, email: undefined, password: undefined, credentialsPath: "/home/.kankaku/credentials.json", localCheckoutGuess: "~/desarrollo/soyun.ninja/kankaku-hub" },
    roots: { current: undefined, defaultRoots: ["/work"], path: "/home/.kankaku/tui.json" },
    ...overrides,
  };
}

function stateAt(step: WizardState["step"], overrides: Partial<WizardState> = {}, facts: WizardFacts = baseFacts()): WizardState {
  return { ...createWizardState(facts), step, ...overrides };
}

// ---- createWizardState ----

test("createWizardState: builds agents via detectAgents, in the fixed order", () => {
  const state = createWizardState(baseFacts());
  assert.deepEqual(
    state.agents.map((a) => a.id),
    ["pi", "gentle-shell", "claude-code", "codex", "opencode"],
  );
  assert.equal(state.step, "detect");
  assert.deepEqual(state.plan, []);
  assert.deepEqual(state.results, []);
  assert.deepEqual(state.errors, {});
});

test("createWizardState: selected starts equal to configured for pi/gentle-shell/claude-code", () => {
  const facts = baseFacts({
    agentFacts: {
      ...baseAgentFacts(),
      pi: { settingsPath: "/home/.pi/agent/settings.json", packages: ["npm:kankaku"] },
      gentleShell: { settingsPath: "/home/.gentle-shell/agent/settings.json", packages: [] },
      claudeCode: { settingsPath: "/home/.claude/settings.json", statusLineCommand: undefined },
    },
  });
  const state = createWizardState(facts);
  assert.equal(state.selected.pi, true);
  assert.equal(state.selected["gentle-shell"], false);
  assert.equal(state.selected["claude-code"], false);
});

test("createWizardState: codex/opencode are never selected initially (no adapter)", () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), codex: { configPath: "/home/.codex/config.toml" }, opencode: { configPath: "/home/.config/opencode/opencode.json" } } });
  const state = createWizardState(facts);
  assert.equal(state.selected.codex, false);
  assert.equal(state.selected.opencode, false);
});

test("createWizardState: hub mode is 'existing' when credentials are present, prefilling url/email/password", () => {
  const facts = baseFacts({ hub: { credentialsPresent: true, url: "https://hub.example.com", email: "a@b.com", password: "secret", credentialsPath: "/home/.kankaku/credentials.json", localCheckoutGuess: "" } });
  const state = createWizardState(facts);
  assert.equal(state.hub.mode, "existing");
  assert.equal(state.hub.url, "https://hub.example.com");
  assert.equal(state.hub.email, "a@b.com");
  assert.equal(state.hub.password, "secret");
});

test("createWizardState: hub mode is 'skip' when no credentials exist", () => {
  const state = createWizardState(baseFacts());
  assert.equal(state.hub.mode, "skip");
  assert.equal(state.hub.url, "");
  assert.equal(state.hub.email, "");
  assert.equal(state.hub.password, "");
});

test("createWizardState: hub.localCheckout starts as the guessed checkout", () => {
  const state = createWizardState(baseFacts({ hub: { credentialsPresent: false, url: undefined, email: undefined, password: undefined, credentialsPath: "/x", localCheckoutGuess: "/home/dev/kankaku-hub" } }));
  assert.equal(state.hub.localCheckout, "/home/dev/kankaku-hub");
  assert.equal(state.hub.localManual, false);
});

test("createWizardState: claudeCheckout is guessed from the current statusLine command", () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), claudeCode: { settingsPath: "/home/.claude/settings.json", statusLineCommand: 'node "/Users/dev/kankaku-claude/src/statusline.ts"' } } });
  const state = createWizardState(facts);
  assert.equal(state.claudeCheckout, "/Users/dev/kankaku-claude");
});

test("createWizardState: claudeCheckout is empty when there is no statusLine to guess from", () => {
  const state = createWizardState(baseFacts());
  assert.equal(state.claudeCheckout, "");
});

test("createWizardState: roots default to the current tui.json roots when present", () => {
  const state = createWizardState(baseFacts({ roots: { current: ["/a", "/b"], defaultRoots: ["/work"], path: "/x" } }));
  assert.deepEqual(state.roots, ["/a", "/b"]);
});

test("createWizardState: roots fall back to the default when no tui.json exists", () => {
  const state = createWizardState(baseFacts({ roots: { current: undefined, defaultRoots: ["/work"], path: "/x" } }));
  assert.deepEqual(state.roots, ["/work"]);
});

// ---- guessClaudeCheckout ----

test("guessClaudeCheckout: extracts the checkout path from the exact command kankaku-tui writes", () => {
  assert.equal(guessClaudeCheckout('node "/Users/dev/kankaku-claude/src/statusline.ts"'), "/Users/dev/kankaku-claude");
});

test("guessClaudeCheckout: returns '' for an unrelated command", () => {
  assert.equal(guessClaudeCheckout("node other.js"), "");
});

test("guessClaudeCheckout: returns '' when undefined", () => {
  assert.equal(guessClaudeCheckout(undefined), "");
});

// ---- toggleAgent ----

test("toggleAgent: flips selected for pi", () => {
  const state = createWizardState(baseFacts());
  const toggled = toggleAgent(state, "pi");
  assert.equal(toggled.selected.pi, true);
  assert.equal(toggleAgent(toggled, "pi").selected.pi, false);
});

test("toggleAgent: is a no-op for codex", () => {
  const state = createWizardState(baseFacts());
  assert.deepEqual(toggleAgent(state, "codex").selected, state.selected);
});

test("toggleAgent: is a no-op for opencode", () => {
  const state = createWizardState(baseFacts());
  assert.deepEqual(toggleAgent(state, "opencode").selected, state.selected);
});

// ---- field setters ----

test("setClaudeCheckout: sets the value and clears its error", () => {
  const state = { ...createWizardState(baseFacts()), errors: { claudeCheckout: "enter a path" } };
  const updated = setClaudeCheckout(state, "/checkout");
  assert.equal(updated.claudeCheckout, "/checkout");
  assert.equal(updated.errors.claudeCheckout, undefined);
});

test("setHubMode: switches mode and clears hub errors", () => {
  const state = { ...createWizardState(baseFacts()), errors: { url: "bad", email: "bad" } };
  const updated = setHubMode(state, "local");
  assert.equal(updated.hub.mode, "local");
  assert.deepEqual(updated.errors, {});
});

test("setHubField: updates url", () => {
  const state = createWizardState(baseFacts());
  assert.equal(setHubField(state, "url", "https://x").hub.url, "https://x");
});

test("setHubField: updates email", () => {
  const state = createWizardState(baseFacts());
  assert.equal(setHubField(state, "email", "a@b.com").hub.email, "a@b.com");
});

test("setHubField: updates password and clears its error", () => {
  const state = { ...createWizardState(baseFacts()), errors: { password: "required" } };
  const updated = setHubField(state, "password", "secret");
  assert.equal(updated.hub.password, "secret");
  assert.equal(updated.errors.password, undefined);
});

test("setHubHealth: records the last health check result", () => {
  const state = createWizardState(baseFacts());
  assert.equal(setHubHealth(state, true).hub.healthOk, true);
  assert.equal(setHubHealth(state, false).hub.healthOk, false);
});

test("setRoots: parses a comma-separated list, trimming and dropping empties", () => {
  const state = createWizardState(baseFacts());
  const updated = setRoots(state, " /a ,/b,, /c/d ,");
  assert.deepEqual(updated.roots, ["/a", "/b", "/c/d"]);
});

test("setLocalCheckout: sets the checkout path and clears its error", () => {
  const state = { ...createWizardState(baseFacts()), errors: { localCheckout: "enter a path" } };
  const updated = setLocalCheckout(state, "/hub-checkout");
  assert.equal(updated.hub.localCheckout, "/hub-checkout");
  assert.equal(updated.errors.localCheckout, undefined);
});

test("setHubLocalManual: acknowledges manual install and clears the checkout error", () => {
  const state = { ...createWizardState(baseFacts()), errors: { localCheckout: "enter a path" } };
  const updated = setHubLocalManual(state, true);
  assert.equal(updated.hub.localManual, true);
  assert.equal(updated.errors.localCheckout, undefined);
});

// ---- next() ----

test("next: detect -> agents", () => {
  const state = stateAt("detect");
  assert.equal(next(state, baseFacts()).step, "agents");
});

test("next: agents -> claude when Claude is selected and not configured", () => {
  const facts = baseFacts();
  const state = toggleAgent(stateAt("agents", {}, facts), "claude-code");
  assert.equal(next(state, facts).step, "claude");
});

test("next: agents -> hub when Claude is not selected", () => {
  const facts = baseFacts();
  const state = stateAt("agents", {}, facts);
  assert.equal(state.selected["claude-code"], false);
  assert.equal(next(state, facts).step, "hub");
});

test("next: agents -> hub when Claude is selected but already configured", () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), claudeCode: { settingsPath: "/home/.claude/settings.json", statusLineCommand: 'node "/x/kankaku-claude/src/statusline.ts"' } } });
  const state = stateAt("agents", {}, facts);
  assert.equal(state.selected["claude-code"], true);
  assert.equal(next(state, facts).step, "hub");
});

test("next: claude step stays and reports an error when the checkout is empty", () => {
  const facts = baseFacts();
  const state = stateAt("claude", { claudeCheckout: "" }, facts);
  const result = next(state, facts);
  assert.equal(result.step, "claude");
  assert.equal(typeof result.errors.claudeCheckout, "string");
});

test("next: claude step advances to hub once the checkout is set", () => {
  const facts = baseFacts();
  const state = stateAt("claude", { claudeCheckout: "/checkout" }, facts);
  const result = next(state, facts);
  assert.equal(result.step, "hub");
  assert.equal(result.errors.claudeCheckout, undefined);
});

test("next: hub existing mode rejects a non-http(s) url", () => {
  const facts = baseFacts();
  const state = stateAt("hub", { hub: { mode: "existing", url: "ftp://x", email: "a@b.com", password: "secret", localCheckout: "", localManual: false } }, facts);
  const result = next(state, facts);
  assert.equal(result.step, "hub");
  assert.equal(typeof result.errors.url, "string");
});

test("next: hub existing mode rejects an email without '@'", () => {
  const facts = baseFacts();
  const state = stateAt("hub", { hub: { mode: "existing", url: "https://x", email: "not-an-email", password: "secret", localCheckout: "", localManual: false } }, facts);
  const result = next(state, facts);
  assert.equal(result.step, "hub");
  assert.equal(typeof result.errors.email, "string");
});

test("next: hub existing mode rejects an empty password", () => {
  const facts = baseFacts();
  const state = stateAt("hub", { hub: { mode: "existing", url: "https://x", email: "a@b.com", password: "", localCheckout: "", localManual: false } }, facts);
  const result = next(state, facts);
  assert.equal(result.step, "hub");
  assert.equal(typeof result.errors.password, "string");
});

test("next: hub existing mode with valid fields advances to roots", () => {
  const facts = baseFacts();
  const state = stateAt("hub", { hub: { mode: "existing", url: "https://x", email: "a@b.com", password: "secret", localCheckout: "", localManual: false } }, facts);
  assert.equal(next(state, facts).step, "roots");
});

test("next: hub local mode rejects an empty checkout with no manual acknowledgement", () => {
  const facts = baseFacts();
  const state = stateAt("hub", { hub: { mode: "local", url: "", email: "", password: "", localCheckout: "", localManual: false } }, facts);
  const result = next(state, facts);
  assert.equal(result.step, "hub");
  assert.equal(typeof result.errors.localCheckout, "string");
});

test("next: hub local mode advances when manual install is acknowledged", () => {
  const facts = baseFacts();
  const state = stateAt("hub", { hub: { mode: "local", url: "", email: "", password: "", localCheckout: "", localManual: true } }, facts);
  assert.equal(next(state, facts).step, "roots");
});

test("next: hub local mode advances when a checkout path is set", () => {
  const facts = baseFacts();
  const state = stateAt("hub", { hub: { mode: "local", url: "", email: "", password: "", localCheckout: "/hub", localManual: false } }, facts);
  assert.equal(next(state, facts).step, "roots");
});

test("next: hub skip mode always advances", () => {
  const facts = baseFacts();
  const state = stateAt("hub", { hub: { mode: "skip", url: "", email: "", password: "", localCheckout: "", localManual: false } }, facts);
  assert.equal(next(state, facts).step, "roots");
});

test("next: roots step stays and reports an error when empty", () => {
  const facts = baseFacts();
  const state = stateAt("roots", { roots: [] }, facts);
  const result = next(state, facts);
  assert.equal(result.step, "roots");
  assert.equal(typeof result.errors.roots, "string");
});

test("next: roots step advances to review and computes the plan", () => {
  const facts = baseFacts({ roots: { current: undefined, defaultRoots: ["/work"], path: "/x/tui.json" } });
  const state = stateAt("roots", { roots: ["/work", "/other"] }, facts);
  const result = next(state, facts);
  assert.equal(result.step, "review");
  assert.equal(result.plan.length > 0, true);
  assert.equal(result.plan.some((a) => a.kind === "write-roots"), true);
});

test("next: review -> apply", () => {
  const facts = baseFacts();
  assert.equal(next(stateAt("review", {}, facts), facts).step, "apply");
});

test("next: apply stays while results are incomplete", () => {
  const facts = baseFacts();
  const plan = [{ kind: "write-roots" as const, file: "/x", label: "write roots" }];
  const state = stateAt("apply", { plan, results: [] }, facts);
  assert.equal(next(state, facts).step, "apply");
});

test("next: apply advances to done once every action has a result", () => {
  const facts = baseFacts();
  const action = { kind: "write-roots" as const, file: "/x", label: "write roots" };
  const state = stateAt("apply", { plan: [action], results: [{ action, outcome: "wrote" as const }] }, facts);
  assert.equal(next(state, facts).step, "done");
});

test("next: done is terminal", () => {
  const facts = baseFacts();
  const state = stateAt("done", {}, facts);
  assert.equal(next(state, facts).step, "done");
});

// ---- back() ----

test("back: agents -> detect", () => {
  assert.equal(back(stateAt("agents")).step, "detect");
});

test("back: claude -> agents", () => {
  assert.equal(back(stateAt("claude")).step, "agents");
});

test("back: hub -> claude when the claude step was shown", () => {
  const state = toggleAgent(stateAt("hub"), "claude-code");
  assert.equal(back(state).step, "claude");
});

test("back: hub -> agents when the claude step was skipped", () => {
  const state = stateAt("hub");
  assert.equal(state.selected["claude-code"], false);
  assert.equal(back(state).step, "agents");
});

test("back: roots -> hub", () => {
  assert.equal(back(stateAt("roots")).step, "hub");
});

test("back: review -> roots", () => {
  assert.equal(back(stateAt("review")).step, "roots");
});

test("back: detect is a no-op", () => {
  assert.equal(back(stateAt("detect")).step, "detect");
});

test("back: apply is a no-op", () => {
  assert.equal(back(stateAt("apply")).step, "apply");
});

// ---- planFromWizard ----

test("planFromWizard: install-pi when pi is selected and not configured", () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), pi: { settingsPath: "/home/.pi/agent/settings.json", packages: [] } } });
  const state = toggleAgent(createWizardState(facts), "pi");
  const plan = planFromWizard(state, facts);
  assert.deepEqual(plan.find((a) => a.file === "/home/.pi/agent/settings.json"), {
    kind: "install-pi",
    file: "/home/.pi/agent/settings.json",
    label: "install kankaku in pi (/home/.pi/agent/settings.json)",
  });
});

test("planFromWizard: remove-pi when pi is unselected but configured", () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), pi: { settingsPath: "/home/.pi/agent/settings.json", packages: ["npm:kankaku"] } } });
  const state = toggleAgent(createWizardState(facts), "pi");
  const plan = planFromWizard(state, facts);
  assert.deepEqual(plan.find((a) => a.file === "/home/.pi/agent/settings.json"), {
    kind: "remove-pi",
    file: "/home/.pi/agent/settings.json",
    label: "remove kankaku from pi (/home/.pi/agent/settings.json)",
  });
});

test("planFromWizard: no action when selection already matches the configured state", () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), pi: { settingsPath: "/home/.pi/agent/settings.json", packages: [] } } });
  const state = createWizardState(facts);
  const plan = planFromWizard(state, facts);
  assert.equal(plan.some((a) => a.file === "/home/.pi/agent/settings.json"), false);
});

test("planFromWizard: gentle-shell reuses the same install-pi/remove-pi kinds", () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), gentleShell: { settingsPath: "/home/.gentle-shell/agent/settings.json", packages: [] } } });
  const state = toggleAgent(createWizardState(facts), "gentle-shell");
  const plan = planFromWizard(state, facts);
  const action = plan.find((a) => a.file === "/home/.gentle-shell/agent/settings.json");
  assert.equal(action?.kind, "install-pi");
});

test("planFromWizard: write-claude when Claude is selected and configured with a checkout", () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), claudeCode: { settingsPath: "/home/.claude/settings.json", statusLineCommand: undefined } } });
  const state = setClaudeCheckout(toggleAgent(createWizardState(facts), "claude-code"), "/checkout");
  const plan = planFromWizard(state, facts);
  assert.deepEqual(plan.find((a) => a.kind === "write-claude"), {
    kind: "write-claude",
    file: "/home/.claude/settings.json",
    label: "set the Claude Code status line (/home/.claude/settings.json)",
  });
});

test("planFromWizard: remove-claude when Claude is unselected but configured", () => {
  const facts = baseFacts({ agentFacts: { ...baseAgentFacts(), claudeCode: { settingsPath: "/home/.claude/settings.json", statusLineCommand: 'node "/x/kankaku-claude/src/statusline.ts"' } } });
  const state = toggleAgent(createWizardState(facts), "claude-code");
  const plan = planFromWizard(state, facts);
  assert.equal(plan.some((a) => a.kind === "remove-claude" && a.file === "/home/.claude/settings.json"), true);
});

test("planFromWizard: write-hub in existing mode when fields changed vs current credentials", () => {
  const facts = baseFacts({ hub: { credentialsPresent: true, url: "https://old", email: "a@b.com", password: "old", credentialsPath: "/home/.kankaku/credentials.json", localCheckoutGuess: "" } });
  let state = createWizardState(facts);
  state = setHubField(state, "url", "https://new");
  const plan = planFromWizard(state, facts);
  assert.equal(plan.some((a) => a.kind === "write-hub" && a.file === "/home/.kankaku/credentials.json"), true);
});

test("planFromWizard: no write-hub in existing mode when nothing changed", () => {
  const facts = baseFacts({ hub: { credentialsPresent: true, url: "https://old", email: "a@b.com", password: "old", credentialsPath: "/home/.kankaku/credentials.json", localCheckoutGuess: "" } });
  const state = createWizardState(facts);
  const plan = planFromWizard(state, facts);
  assert.equal(plan.some((a) => a.kind === "write-hub"), false);
});

test("planFromWizard: install-local-hub in local mode with a checkout", () => {
  const facts = baseFacts();
  const state = setLocalCheckout(setHubMode(createWizardState(facts), "local"), "/hub-checkout");
  const plan = planFromWizard(state, facts);
  assert.deepEqual(plan.find((a) => a.kind === "install-local-hub"), {
    kind: "install-local-hub",
    file: "/hub-checkout",
    label: "install a local hub from /hub-checkout",
  });
});

test("planFromWizard: no install-local-hub in local mode with no checkout (manual)", () => {
  const facts = baseFacts({ hub: { credentialsPresent: false, url: undefined, email: undefined, password: undefined, credentialsPath: "/home/.kankaku/credentials.json", localCheckoutGuess: "" } });
  const state = setHubLocalManual(setHubMode(createWizardState(facts), "local"), true);
  const plan = planFromWizard(state, facts);
  assert.equal(plan.some((a) => a.kind === "install-local-hub"), false);
});

test("planFromWizard: no hub action in skip mode", () => {
  const facts = baseFacts();
  const state = createWizardState(facts);
  assert.equal(state.hub.mode, "skip");
  const plan = planFromWizard(state, facts);
  assert.equal(plan.some((a) => a.kind === "write-hub" || a.kind === "install-local-hub"), false);
});

test("planFromWizard: write-roots when roots differ from current", () => {
  const facts = baseFacts({ roots: { current: ["/old"], defaultRoots: ["/old"], path: "/x/tui.json" } });
  const state = setRoots(createWizardState(facts), "/new");
  const plan = planFromWizard(state, facts);
  assert.deepEqual(plan.find((a) => a.kind === "write-roots"), { kind: "write-roots", file: "/x/tui.json", label: "write roots to /x/tui.json" });
});

test("planFromWizard: no write-roots when roots match current exactly", () => {
  const facts = baseFacts({ roots: { current: ["/a", "/b"], defaultRoots: ["/a", "/b"], path: "/x/tui.json" } });
  const state = createWizardState(facts);
  const plan = planFromWizard(state, facts);
  assert.equal(plan.some((a) => a.kind === "write-roots"), false);
});

test("planFromWizard: write-roots when there is no current tui.json at all", () => {
  const facts = baseFacts({ roots: { current: undefined, defaultRoots: ["/a"], path: "/x/tui.json" } });
  const state = createWizardState(facts);
  const plan = planFromWizard(state, facts);
  assert.equal(plan.some((a) => a.kind === "write-roots"), true);
});

// ---- applyResult ----

test("applyResult: appends a result", () => {
  const facts = baseFacts();
  const state = createWizardState(facts);
  const action = { kind: "write-roots" as const, file: "/x", label: "write roots" };
  const updated = applyResult(state, { action, outcome: "wrote" });
  assert.deepEqual(updated.results, [{ action, outcome: "wrote" }]);
});

test("applyResult: keeps prior results and appends in order", () => {
  const action1 = { kind: "write-roots" as const, file: "/x", label: "a" };
  const action2 = { kind: "write-hub" as const, file: "/y", label: "b" };
  let state = createWizardState(baseFacts());
  state = applyResult(state, { action: action1, outcome: "wrote" });
  state = applyResult(state, { action: action2, outcome: "error", detail: "boom" });
  assert.equal(state.results.length, 2);
  assert.equal(state.results[1]?.detail, "boom");
});

// ---- hintsForStep ----

test("hintsForStep: agents includes toggle, move, next, back and quit", () => {
  const hints = hintsForStep("agents");
  const keys = hints.map((h) => h.key);
  assert.equal(keys.includes("space"), true);
  assert.equal(keys.includes("q"), true);
});

test("hintsForStep: apply has no back/next, only quit", () => {
  const hints = hintsForStep("apply");
  assert.deepEqual(hints, [{ key: "q", label: "quit" }]);
});

test("hintsForStep: review offers apply instead of next", () => {
  const hints = hintsForStep("review");
  assert.equal(hints.some((h) => h.label === "apply"), true);
});

test("hintsForStep: done offers to open the dashboard", () => {
  const hints = hintsForStep("done");
  assert.equal(hints.some((h) => h.label === "open dashboard"), true);
});
