/**
 * Pure domain for `kankaku setup`'s interactive wizard: one `WizardState`
 * carrying the current step, the user's in-progress answers, the computed
 * plan and the applied results, plus reducers that transition it. No I/O —
 * callers (`src/ui/setup/*`, `src/cli.tsx`) read the real files and pass
 * plain facts in via `WizardFacts`, exactly like `domain/setup-plan.ts`.
 */
import { detectAgents } from "./setup-plan.ts";
import type { AgentDetectionFacts, AgentId, AgentStatus } from "./setup-plan.ts";

export type WizardStep = "agents" | "hub" | "roots" | "review" | "apply" | "done";

export type HubMode = "existing" | "local" | "skip";

export interface WizardHubState {
  mode: HubMode;
  url: string;
  email: string;
  password: string;
  /** Result of the last inline health check; `undefined` until one has run. */
  healthOk?: boolean;
  /** The owner account created by `install-local-hub` (`hub-manager/install.ts#installHub`) — asked only in `local` mode. */
  ownerEmail: string;
  ownerPassword: string;
}

export type WizardErrorKey = "url" | "email" | "password" | "roots" | "ownerEmail" | "ownerPassword";

export type WizardActionKind = "install-pi" | "remove-pi" | "write-claude" | "remove-claude" | "write-hub" | "install-local-hub" | "write-roots";

export interface WizardAction {
  kind: WizardActionKind;
  /** The exact file this action changes (or the local hub's URL for `install-local-hub`). */
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
}

/** The local hub's fixed port for the wizard's `install locally` review line and `install-local-hub` action — mirrors `hub-manager/install.ts#DEFAULT_HUB_PORT`. */
export const DEFAULT_HUB_PORT = 8090;

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
  /** The user's home directory, used only to shorten a displayed file path with `~` (see {@link shortenHome}). */
  homeDir: string;
}

export interface WizardKeyHint {
  key: string;
  label: string;
}

/**
 * Shorten `path` for display by replacing a leading `homeDir` with `~`.
 * Only a real path-boundary match counts (`homeDir` itself, or `homeDir`
 * followed by `/`) — a sibling directory that merely shares the prefix
 * (e.g. `/homework` vs `/home`) is left unchanged. `path` is returned as-is
 * when it doesn't start under `homeDir`.
 */
export function shortenHome(path: string, homeDir: string): string {
  if (homeDir === "") return path;
  if (path === homeDir) return "~";
  if (path.startsWith(`${homeDir}/`)) return `~${path.slice(homeDir.length)}`;
  return path;
}

function clearError(errors: WizardState["errors"], key: WizardErrorKey): WizardState["errors"] {
  if (!(key in errors)) return errors;
  const rest = { ...errors };
  delete rest[key];
  return rest;
}

const HUB_ERROR_KEYS: WizardErrorKey[] = ["url", "email", "password", "ownerEmail", "ownerPassword"];

function clearHubErrors(errors: WizardState["errors"]): WizardState["errors"] {
  return HUB_ERROR_KEYS.reduce((acc, key) => clearError(acc, key), errors);
}

/** Build the wizard's initial state from plain, already-read facts: agent detection, current hub credentials and current `tui.json` roots. */
export function createWizardState(facts: WizardFacts): WizardState {
  const agents = detectAgents(facts.agentFacts);
  const selected = Object.fromEntries(agents.map((agent) => [agent.id, agent.configured])) as Record<AgentId, boolean>;

  return {
    step: "agents",
    agents,
    selected,
    hub: {
      mode: facts.hub.credentialsPresent ? "existing" : "skip",
      url: facts.hub.url ?? "",
      email: facts.hub.email ?? "",
      password: facts.hub.password ?? "",
      ownerEmail: "",
      ownerPassword: "",
    },
    roots: facts.roots.current ?? facts.roots.defaultRoots,
    errors: {},
    plan: [],
    results: [],
  };
}

export function toggleAgent(state: WizardState, id: AgentId): WizardState {
  if (id === "codex" || id === "opencode") return state;
  return { ...state, selected: { ...state.selected, [id]: !state.selected[id] } };
}

export function setHubMode(state: WizardState, mode: HubMode): WizardState {
  return { ...state, hub: { ...state.hub, mode }, errors: clearHubErrors(state.errors) };
}

export type HubField = "url" | "email" | "password" | "ownerEmail" | "ownerPassword";

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

function validateHub(hub: WizardHubState): Partial<Record<WizardErrorKey, string>> {
  if (hub.mode === "existing") {
    const errors: Partial<Record<WizardErrorKey, string>> = {};
    if (!/^https?:\/\//.test(hub.url)) errors.url = "enter a http(s) URL";
    if (!hub.email.includes("@")) errors.email = "enter a valid email";
    if (hub.password.trim() === "") errors.password = "enter a password";
    return errors;
  }
  if (hub.mode === "local") {
    const errors: Partial<Record<WizardErrorKey, string>> = {};
    if (!hub.ownerEmail.includes("@")) errors.ownerEmail = "enter a valid email";
    if (hub.ownerPassword.trim() === "") errors.ownerPassword = "enter a password";
    return errors;
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
          ? { kind: "write-claude", file: claude.detail, label: `configure Claude Code (statusLine + hooks) in ${claude.detail}` }
          : { kind: "remove-claude", file: claude.detail, label: `remove kankaku from Claude Code (${claude.detail})` },
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
  } else if (state.hub.mode === "local") {
    const url = `http://127.0.0.1:${DEFAULT_HUB_PORT}`;
    actions.push({ kind: "install-local-hub", file: url, label: `install a local hub at ${url}` });
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
    case "agents":
      return { ...state, step: "hub", errors: {} };

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

/** Move back to the previous step. Terminal/first steps (`agents`, `apply`, `done`) are no-ops. */
export function back(state: WizardState): WizardState {
  switch (state.step) {
    case "agents":
      return state;
    case "hub":
      return { ...state, step: "agents", errors: {} };
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
    case "agents":
      // The first step: esc quits (handled by the caller), so it isn't hinted as "back" here.
      return [{ key: "space", label: "toggle" }, { key: "↑↓", label: "move" }, { key: "enter", label: "next" }, quit];
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
