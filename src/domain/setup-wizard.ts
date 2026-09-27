/**
 * Pure domain for `kankaku setup`'s interactive wizard: one `WizardState`
 * carrying the current step, the user's in-progress answers, the computed
 * plan and the applied results, plus reducers that transition it. No I/O —
 * callers (`src/ui/setup/*`, `src/cli.tsx`) read the real files and pass
 * plain facts in via `WizardFacts`, exactly like `domain/setup-plan.ts`.
 */
import { detectAgents } from "./setup-plan.ts";
import type { AgentDetectionFacts, AgentId, AgentStatus } from "./setup-plan.ts";

export type WizardStep = "detect" | "agents" | "claude" | "hub" | "roots" | "review" | "apply" | "done";

export type HubMode = "existing" | "local" | "skip";

export interface WizardHubState {
  mode: HubMode;
  url: string;
  email: string;
  password: string;
  /** Result of the last inline health check; `undefined` until one has run. */
  healthOk?: boolean;
  localCheckout: string;
  /** Acknowledges installing the local hub manually when no checkout was found. */
  localManual: boolean;
}

export type WizardErrorKey = "claudeCheckout" | "url" | "email" | "password" | "roots" | "localCheckout";

export type WizardActionKind = "install-pi" | "remove-pi" | "write-claude" | "remove-claude" | "write-hub" | "install-local-hub" | "write-roots";

export interface WizardAction {
  kind: WizardActionKind;
  /** The exact file this action changes (or the checkout path for `install-local-hub`). */
  file: string;
  /** Human-readable description shown on the review screen. */
  label: string;
}

export type ApplyOutcome = "wrote" | "unchanged" | "removed" | "started" | "error";

export interface ApplyResult {
  action: WizardAction;
  outcome: ApplyOutcome;
  detail?: string;
}

export interface WizardState {
  step: WizardStep;
  agents: AgentStatus[];
  selected: Record<AgentId, boolean>;
  claudeCheckout: string;
  hub: WizardHubState;
  roots: string[];
  errors: Partial<Record<WizardErrorKey, string>>;
  plan: WizardAction[];
  results: ApplyResult[];
}

export interface WizardHubFacts {
  credentialsPresent: boolean;
  url: string | undefined;
  email: string | undefined;
  password: string | undefined;
  credentialsPath: string;
  /** Default checkout path to prefill for a local install (an auto-detected checkout, or a sensible default). */
  localCheckoutGuess: string;
}

export interface WizardRootsFacts {
  /** The roots currently written to `tui.json`, or `undefined` when it does not exist yet. */
  current: string[] | undefined;
  defaultRoots: string[];
  path: string;
}

export interface WizardFacts {
  agentFacts: AgentDetectionFacts;
  hub: WizardHubFacts;
  roots: WizardRootsFacts;
}

export interface WizardKeyHint {
  key: string;
  label: string;
}

const CLAUDE_STATUS_LINE_RE = /^node "(.+)\/src\/statusline\.ts"$/;

/** The inverse of `adapters/setup/claude.ts#statusLineCommand`: recovers the checkout path from an existing `statusLine.command`, or `""` when it isn't kankaku's. */
export function guessClaudeCheckout(statusLineCommand: string | undefined): string {
  if (!statusLineCommand) return "";
  const match = CLAUDE_STATUS_LINE_RE.exec(statusLineCommand);
  return match ? match[1]! : "";
}

function clearError(errors: WizardState["errors"], key: WizardErrorKey): WizardState["errors"] {
  if (!(key in errors)) return errors;
  const rest = { ...errors };
  delete rest[key];
  return rest;
}

const HUB_ERROR_KEYS: WizardErrorKey[] = ["url", "email", "password", "localCheckout"];

function clearHubErrors(errors: WizardState["errors"]): WizardState["errors"] {
  return HUB_ERROR_KEYS.reduce((acc, key) => clearError(acc, key), errors);
}

/** Build the wizard's initial state from plain, already-read facts: agent detection, current hub credentials and current `tui.json` roots. */
export function createWizardState(facts: WizardFacts): WizardState {
  const agents = detectAgents(facts.agentFacts);
  const selected = Object.fromEntries(agents.map((agent) => [agent.id, agent.configured])) as Record<AgentId, boolean>;

  return {
    step: "detect",
    agents,
    selected,
    claudeCheckout: guessClaudeCheckout(facts.agentFacts.claudeCode?.statusLineCommand),
    hub: {
      mode: facts.hub.credentialsPresent ? "existing" : "skip",
      url: facts.hub.url ?? "",
      email: facts.hub.email ?? "",
      password: facts.hub.password ?? "",
      localCheckout: facts.hub.localCheckoutGuess,
      localManual: false,
    },
    roots: facts.roots.current ?? facts.roots.defaultRoots,
    errors: {},
    plan: [],
    results: [],
  };
}

/** Whether the Claude Code step should be shown: Claude is selected and not already configured. */
function claudeStepNeeded(state: WizardState): boolean {
  const claude = state.agents.find((agent) => agent.id === "claude-code");
  return state.selected["claude-code"] === true && claude !== undefined && !claude.configured;
}

export function toggleAgent(state: WizardState, id: AgentId): WizardState {
  if (id === "codex" || id === "opencode") return state;
  return { ...state, selected: { ...state.selected, [id]: !state.selected[id] } };
}

export function setClaudeCheckout(state: WizardState, value: string): WizardState {
  return { ...state, claudeCheckout: value, errors: clearError(state.errors, "claudeCheckout") };
}

export function setHubMode(state: WizardState, mode: HubMode): WizardState {
  return { ...state, hub: { ...state.hub, mode }, errors: clearHubErrors(state.errors) };
}

export type HubField = "url" | "email" | "password";

export function setHubField(state: WizardState, field: HubField, value: string): WizardState {
  return { ...state, hub: { ...state.hub, [field]: value }, errors: clearError(state.errors, field) };
}

export function setHubHealth(state: WizardState, ok: boolean): WizardState {
  return { ...state, hub: { ...state.hub, healthOk: ok } };
}

/** Parses a comma-separated list of roots: trims each entry and drops empties. */
export function setRoots(state: WizardState, text: string): WizardState {
  const roots = text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return { ...state, roots, errors: clearError(state.errors, "roots") };
}

export function setLocalCheckout(state: WizardState, value: string): WizardState {
  return { ...state, hub: { ...state.hub, localCheckout: value }, errors: clearError(state.errors, "localCheckout") };
}

export function setHubLocalManual(state: WizardState, manual: boolean): WizardState {
  return { ...state, hub: { ...state.hub, localManual: manual }, errors: clearError(state.errors, "localCheckout") };
}

function validateHub(hub: WizardHubState): Partial<Record<WizardErrorKey, string>> {
  if (hub.mode === "existing") {
    const errors: Partial<Record<WizardErrorKey, string>> = {};
    if (!/^https?:\/\//.test(hub.url)) errors.url = "enter a http(s) URL";
    if (!hub.email.includes("@")) errors.email = "enter a valid email";
    if (hub.password.trim() === "") errors.password = "enter a password";
    return errors;
  }
  if (hub.mode === "local") {
    if (hub.localCheckout.trim() === "" && !hub.localManual) {
      return { localCheckout: "enter a checkout path, or acknowledge installing manually" };
    }
    return {};
  }
  return {};
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

const PI_HOME_AGENTS: { id: AgentId; title: string }[] = [
  { id: "pi", title: "pi" },
  { id: "gentle-shell", title: "gentle-shell" },
];

/** Build the ordered plan from the current wizard answers, diffed against `facts`' current on-disk state. */
export function planFromWizard(state: WizardState, facts: WizardFacts): WizardAction[] {
  const actions: WizardAction[] = [];

  for (const { id, title } of PI_HOME_AGENTS) {
    const agent = state.agents.find((candidate) => candidate.id === id);
    if (!agent || !agent.adapterAvailable) continue;
    const selected = state.selected[id] === true;
    if (selected === agent.configured) continue;
    actions.push(
      selected
        ? { kind: "install-pi", file: agent.detail, label: `install kankaku in ${title} (${agent.detail})` }
        : { kind: "remove-pi", file: agent.detail, label: `remove kankaku from ${title} (${agent.detail})` },
    );
  }

  const claude = state.agents.find((agent) => agent.id === "claude-code");
  if (claude && claude.adapterAvailable) {
    const selected = state.selected["claude-code"] === true;
    if (selected !== claude.configured) {
      actions.push(
        selected
          ? { kind: "write-claude", file: claude.detail, label: `set the Claude Code status line (${claude.detail})` }
          : { kind: "remove-claude", file: claude.detail, label: `remove the kankaku status line from Claude Code (${claude.detail})` },
      );
    }
  }

  if (state.hub.mode === "existing") {
    const changed =
      !facts.hub.credentialsPresent ||
      state.hub.url !== (facts.hub.url ?? "") ||
      state.hub.email !== (facts.hub.email ?? "") ||
      state.hub.password !== (facts.hub.password ?? "");
    if (changed) {
      actions.push({ kind: "write-hub", file: facts.hub.credentialsPath, label: `write hub credentials to ${facts.hub.credentialsPath}` });
    }
  } else if (state.hub.mode === "local" && state.hub.localCheckout.trim() !== "") {
    actions.push({ kind: "install-local-hub", file: state.hub.localCheckout, label: `install a local hub from ${state.hub.localCheckout}` });
  }

  const sameRoots = facts.roots.current !== undefined && arraysEqual(facts.roots.current, state.roots);
  if (!sameRoots) {
    actions.push({ kind: "write-roots", file: facts.roots.path, label: `write roots to ${facts.roots.path}` });
  }

  return actions;
}

/** Advance from the current step: validates it, sets `errors` and stays when invalid, otherwise moves on. */
export function next(state: WizardState, facts: WizardFacts): WizardState {
  switch (state.step) {
    case "detect":
      return { ...state, step: "agents", errors: {} };

    case "agents":
      return { ...state, step: claudeStepNeeded(state) ? "claude" : "hub", errors: {} };

    case "claude": {
      if (state.claudeCheckout.trim() === "") {
        return { ...state, errors: { ...state.errors, claudeCheckout: "enter the kankaku-claude checkout path" } };
      }
      return { ...state, step: "hub", errors: clearError(state.errors, "claudeCheckout") };
    }

    case "hub": {
      const hubErrors = validateHub(state.hub);
      if (Object.keys(hubErrors).length > 0) {
        return { ...state, errors: { ...clearHubErrors(state.errors), ...hubErrors } };
      }
      return { ...state, step: "roots", errors: clearHubErrors(state.errors) };
    }

    case "roots": {
      if (state.roots.length === 0) {
        return { ...state, errors: { ...state.errors, roots: "enter at least one root directory" } };
      }
      const reviewState: WizardState = { ...state, step: "review", errors: clearError(state.errors, "roots") };
      return { ...reviewState, plan: planFromWizard(reviewState, facts) };
    }

    case "review":
      return { ...state, step: "apply" };

    case "apply":
      return state.results.length >= state.plan.length ? { ...state, step: "done" } : state;

    case "done":
      return state;
  }
}

/** Move back to the previous step, mirroring `next`'s claude-step skip. Terminal/first steps (`detect`, `apply`, `done`) are no-ops. */
export function back(state: WizardState): WizardState {
  switch (state.step) {
    case "detect":
      return state;
    case "agents":
      return { ...state, step: "detect", errors: {} };
    case "claude":
      return { ...state, step: "agents", errors: {} };
    case "hub":
      return { ...state, step: claudeStepNeeded(state) ? "claude" : "agents", errors: {} };
    case "roots":
      return { ...state, step: "hub", errors: {} };
    case "review":
      return { ...state, step: "roots", errors: {} };
    case "apply":
      return state;
    case "done":
      return state;
  }
}

export function applyResult(state: WizardState, result: ApplyResult): WizardState {
  return { ...state, results: [...state.results, result] };
}

/** The footer key hints for a given step. */
export function hintsForStep(step: WizardStep): WizardKeyHint[] {
  const quit: WizardKeyHint = { key: "q", label: "quit" };
  switch (step) {
    case "detect":
      return [{ key: "enter", label: "next" }, quit];
    case "agents":
      return [{ key: "space", label: "toggle" }, { key: "↑↓", label: "move" }, { key: "enter", label: "next" }, { key: "esc", label: "back" }, quit];
    case "claude":
      return [{ key: "enter", label: "next" }, { key: "esc", label: "back" }, quit];
    case "hub":
      return [{ key: "↑↓", label: "choose" }, { key: "enter", label: "next" }, { key: "esc", label: "back" }, quit];
    case "roots":
      return [{ key: "enter", label: "next" }, { key: "esc", label: "back" }, quit];
    case "review":
      return [{ key: "enter", label: "apply" }, { key: "esc", label: "back" }, quit];
    case "apply":
      return [quit];
    case "done":
      return [{ key: "enter", label: "open dashboard" }, quit];
  }
}
