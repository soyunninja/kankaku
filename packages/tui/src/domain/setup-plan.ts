/**
 * Pure setup domain: which coding agents kankaku can find on this machine,
 * whether each is already configured, and the ordered plan `kankaku setup`
 * and `kankaku doctor` both report from. No I/O, no `Date.now()` — callers
 * read the real files (`src/adapters/setup/*.ts`) and pass plain facts in.
 */

import { ourStatusLineCommandMatch } from "./claude-integration.ts";

export type AgentId = "pi" | "gentle-shell" | "claude-code" | "codex" | "opencode";

export interface AgentStatus {
  id: AgentId;
  /** The agent's settings/config file exists on disk. */
  present: boolean;
  /** kankaku is already wired into that file. Always `false` when `adapterAvailable` is `false`. */
  configured: boolean;
  /** Whether kankaku-tui knows how to write this agent's config at all (`false` for Codex/OpenCode). */
  adapterAvailable: boolean;
  /** The settings file path when `present`, else `"not found"`. */
  detail: string;
  /**
   * Extra context for a partially-configured agent — currently only
   * Claude Code, whose `configured` requires both the statusLine and
   * hooks to be present and point at the same root: `"statusLine only"`,
   * `"hooks only"`, or `"hooks point at <root>, statusLine at <root>"`
   * when they disagree. `undefined` when fully configured, absent, or
   * for every other agent.
   */
  detailNote?: string;
}

/** A pi-family settings file (`pi`, `gentle-shell`): `{ packages: string[], ... }`. */
export interface SettingsPackagesFacts {
  settingsPath: string;
  packages: string[];
}

/** Claude Code's `~/.claude/settings.json`: the `statusLine.command` field and the root our hooks (if any) point at. */
export interface ClaudeSettingsFacts {
  settingsPath: string;
  statusLineCommand: string | undefined;
  /** The plugin root our own hook entries point at, when present (see `adapters/setup/agents.ts#extractHooksMatch`). */
  hooksRoot: string | undefined;
  /** True when the matched hook command uses the legacy `/src/hook.ts` checkout form rather than the current `/dist/hook.js` one. Defaults to `false` when omitted. */
  hooksLegacy?: boolean;
}

/** An agent kankaku-tui only detects, never configures (Codex, OpenCode). */
export interface ConfigFileFacts {
  configPath: string;
}

export interface AgentDetectionFacts {
  pi: SettingsPackagesFacts | undefined;
  gentleShell: SettingsPackagesFacts | undefined;
  claudeCode: ClaudeSettingsFacts | undefined;
  codex: ConfigFileFacts | undefined;
  opencode: ConfigFileFacts | undefined;
}

/**
 * A `packages` entry counts as kankaku when it is the bare npm spec
 * (`npm:kankaku`), a versioned npm spec (`npm:kankaku@x.y.z`), or a path
 * (relative or absolute, npm's `file:`-less local-package shorthand) whose
 * last segment is exactly `kankaku` — e.g. `../../workspace/kankaku`.
 */
export function isKankakuPackage(entry: string): boolean {
  if (entry === "npm:kankaku" || entry.startsWith("npm:kankaku@")) return true;
  const segments = entry.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] === "kankaku";
}

function settingsPackagesStatus(id: AgentId, facts: SettingsPackagesFacts | undefined): AgentStatus {
  if (!facts) return { id, present: false, configured: false, adapterAvailable: true, detail: "not found" };
  return { id, present: true, configured: facts.packages.some(isKankakuPackage), adapterAvailable: true, detail: facts.settingsPath };
}

/**
 * Claude Code is `configured` only when our statusLine AND our hooks are
 * present, share the same root, AND both use the current `/dist/*.js`
 * form (see the module doc on `AgentStatus`) — the legacy `/src/*.ts`
 * checkout form a pre-dist `kankaku setup` may have written is still
 * recognized as ours (see `domain/claude-integration.ts`), but never as
 * fully configured, since Node refuses to type-strip a `.ts` file under
 * `node_modules`. A partial state carries a `detailNote` explaining
 * exactly what's missing, mismatched or outdated, reused by `agentStep`'s
 * `todoAction` and, through it, `kankaku doctor`'s output.
 */
function claudeCodeStatus(facts: ClaudeSettingsFacts | undefined): AgentStatus {
  if (!facts) return { id: "claude-code", present: false, configured: false, adapterAvailable: true, detail: "not found" };

  const statusLineMatch = facts.statusLineCommand !== undefined ? ourStatusLineCommandMatch(facts.statusLineCommand) : undefined;
  const statusLineRoot = statusLineMatch?.root;
  const hooksRoot = facts.hooksRoot;
  const sameRoot = statusLineRoot !== undefined && hooksRoot !== undefined && statusLineRoot === hooksRoot;
  const statusLineLegacy = statusLineMatch?.legacy === true;
  const hooksLegacy = facts.hooksLegacy === true;
  const configured = sameRoot && !statusLineLegacy && !hooksLegacy;

  let detailNote: string | undefined;
  if (!configured) {
    if (statusLineRoot !== undefined && hooksRoot === undefined) detailNote = "statusLine only";
    else if (statusLineRoot === undefined && hooksRoot !== undefined) detailNote = "hooks only";
    else if (statusLineRoot !== undefined && hooksRoot !== undefined && !sameRoot) {
      detailNote = `hooks point at ${hooksRoot}, statusLine at ${statusLineRoot}`;
    } else if (sameRoot) {
      const outdated: string[] = [];
      if (statusLineLegacy) outdated.push("statusLine");
      if (hooksLegacy) outdated.push("hooks");
      detailNote = `outdated ${outdated.join(" and ")}`;
    }
  }

  return { id: "claude-code", present: true, configured, adapterAvailable: true, detail: facts.settingsPath, ...(detailNote !== undefined ? { detailNote } : {}) };
}

function noAdapterStatus(id: AgentId, facts: ConfigFileFacts | undefined): AgentStatus {
  if (!facts) return { id, present: false, configured: false, adapterAvailable: false, detail: "not found" };
  return { id, present: true, configured: false, adapterAvailable: false, detail: facts.configPath };
}

/** Detect every agent kankaku-tui knows about from plain, already-read facts. Order: pi, gentle-shell, claude-code, codex, opencode. */
export function detectAgents(facts: AgentDetectionFacts): AgentStatus[] {
  return [
    settingsPackagesStatus("pi", facts.pi),
    settingsPackagesStatus("gentle-shell", facts.gentleShell),
    claudeCodeStatus(facts.claudeCode),
    noAdapterStatus("codex", facts.codex),
    noAdapterStatus("opencode", facts.opencode),
  ];
}

export type StepState = "done" | "todo" | "unavailable";

export interface SetupStep {
  id: string;
  title: string;
  state: StepState;
  /** Human-readable description of what this step would do, why it is already done, or why it is unavailable. */
  action: string;
  /** The exact file this step would change, or `""` when nothing would be written. */
  file: string;
}

export interface HubPlanFacts {
  credentialsPresent: boolean;
  url: string | undefined;
  /** `undefined` when no health check was attempted (e.g. no credentials to check with). */
  healthOk: boolean | undefined;
  credentialsPath: string;
}

export interface TuiPlanFacts {
  present: boolean;
  path: string;
}

const AGENT_TITLES: Record<AgentId, string> = {
  pi: "pi",
  "gentle-shell": "gentle-shell",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

function todoAction(agent: AgentStatus): string {
  if (agent.id === "claude-code") return `write the kankaku statusLine and hooks to ${agent.detail}${agent.detailNote ? ` (${agent.detailNote})` : ""}`;
  return `add "npm:kankaku" to packages in ${agent.detail}`;
}

function agentStep(agent: AgentStatus): SetupStep {
  const title = AGENT_TITLES[agent.id];
  if (!agent.adapterAvailable) {
    return { id: agent.id, title, state: "unavailable", action: "no adapter yet", file: "" };
  }
  if (!agent.present) {
    return { id: agent.id, title, state: "unavailable", action: `no settings file found (expected ${agent.detail})`, file: "" };
  }
  if (agent.configured) {
    return { id: agent.id, title, state: "done", action: `already configured (${agent.detail})`, file: agent.detail };
  }
  return { id: agent.id, title, state: "todo", action: todoAction(agent), file: agent.detail };
}

function hubStep(hub: HubPlanFacts): SetupStep {
  if (!hub.credentialsPresent) {
    return { id: "hub", title: "Hub", state: "todo", action: `write hub credentials to ${hub.credentialsPath}`, file: hub.credentialsPath };
  }
  if (hub.healthOk === true) {
    return { id: "hub", title: "Hub", state: "done", action: `credentials present (${hub.url}); health check ok`, file: hub.credentialsPath };
  }
  return {
    id: "hub",
    title: "Hub",
    state: "todo",
    action: `credentials present (${hub.url}) but the health check did not succeed; verify the hub is reachable`,
    file: "",
  };
}

function tuiStep(tui: TuiPlanFacts): SetupStep {
  if (tui.present) {
    return { id: "tui-config", title: "TUI config", state: "done", action: `roots already configured (${tui.path})`, file: tui.path };
  }
  return { id: "tui-config", title: "TUI config", state: "todo", action: `write roots to ${tui.path}`, file: tui.path };
}

/** Build the ordered setup plan: one step per detected agent, then the hub, then the TUI's own `tui.json`. */
export function planSetup(agents: AgentStatus[], hub: HubPlanFacts, tui: TuiPlanFacts): SetupStep[] {
  return [...agents.map(agentStep), hubStep(hub), tuiStep(tui)];
}

/**
 * `kankaku doctor`'s plain-text report: one line per agent, one for the
 * hub, one for `tui.json` (`<title>: <state> — <action>`), followed by a
 * `next: <action>` hint for every step still `todo`.
 */
export function formatDoctorLines(agents: AgentStatus[], hub: HubPlanFacts, tui: TuiPlanFacts): string[] {
  const steps = planSetup(agents, hub, tui);
  const statusLines = steps.map((step) => `${step.title}: ${step.state} — ${step.action}`);
  const hints = steps.filter((step) => step.state === "todo").map((step) => `next: ${step.action}`);
  return [...statusLines, ...hints];
}

/** `kankaku setup [--dry-run]`'s plan report: one line per step, appending the exact file it would change (`[<file>]`) when there is one. */
export function formatSetupPlanLines(steps: SetupStep[]): string[] {
  return steps.map((step) => `${step.title}: ${step.state} — ${step.action}${step.file ? ` [${step.file}]` : ""}`);
}
