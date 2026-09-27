import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import {
  DEFAULT_HUB_PORT,
  applyResult,
  back,
  claudeStepNeeded,
  createWizardState,
  hintsForStep,
  next,
  planFromWizard,
  setClaudeCheckout,
  setHubField,
  setHubHealth,
  setHubMode,
  setRoots,
  shortenHome,
  toggleAgent,
} from "../../domain/setup-wizard.ts";
import type { ApplyResult, HubField, HubMode, WizardAction, WizardFacts, WizardState, WizardStep } from "../../domain/setup-wizard.ts";
import type { AgentId, AgentStatus } from "../../domain/setup-plan.ts";
import { HeaderBar } from "../components/header-bar.tsx";
import { KeyHints } from "../components/key-hints.tsx";
import { Panel } from "../components/panel.tsx";
import { Table } from "../components/table.tsx";
import type { TableColumn } from "../components/table.tsx";
import { Checklist } from "../components/checklist.tsx";
import type { ChecklistItem } from "../components/checklist.tsx";
import { Radio } from "../components/radio.tsx";
import type { RadioOption } from "../components/radio.tsx";
import { TextInput } from "../components/text-input.tsx";
import { useTheme } from "../theme.ts";

/** Fallback terminal height when neither `rows` nor `useStdout().rows` is available (matches `ui/layout.tsx`'s own fallback). */
const DEFAULT_ROWS = 24;
/** Rows used by the header line. */
const HEADER_ROWS = 1;
/** Rows used by the footer key-hints line. */
const FOOTER_ROWS = 1;

/**
 * The wizard's own dependency surface, built by `cli.tsx` from the real
 * `adapters/setup/*` writers: `apply` carries the current `WizardState`
 * alongside the plan `WizardAction`, since several actions (`write-claude`,
 * `write-hub`, `write-roots`) need a value that never made it into the
 * action itself (see `domain/setup-wizard.ts#planFromWizard` — `file` is
 * always the target path, never the checkout/credentials/roots to write).
 * `install-local-hub` itself (`hub-manager/install.ts#installHub`) runs
 * entirely inside `apply`; the UI never calls it directly.
 */
export interface WizardActions {
  apply(action: WizardAction, state: WizardState): Promise<ApplyResult>;
  checkHealth(url: string): Promise<boolean>;
}

export interface SetupWizardProps {
  facts: WizardFacts;
  actions: WizardActions;
  /** Called once, from the Done step, when Enter is pressed. */
  onDone: () => void;
  /** Called from the Agents step (the first step) when Esc is pressed (the wizard's own quit). */
  onQuit: () => void;
  /** Shown in the header bar, matching every other screen. Omitted in a standalone render. */
  version?: string;
  columns?: number;
  rows?: number;
}

/** Panel titles for every step. Used verbatim for `apply`/`done` (never numbered); `agents`/`claude`/`hub`/`roots`/`review` get a `n/total` suffix from {@link panelTitle}. */
const STEP_TITLES: Record<WizardStep, string> = {
  agents: "Agents",
  claude: "Claude Code",
  hub: "Hub",
  roots: "Roots",
  review: "Review",
  apply: "Apply",
  done: "Done",
};

/** The steps a run numbers in its panel title, in order; `claude` is dropped from this list when the run doesn't need it (see {@link numberedStepsForRun}). `apply` and `done` are never numbered — `apply` is Review's own execution and `done` is the terminal summary. */
const NUMBERED_STEPS: WizardStep[] = ["agents", "claude", "hub", "roots", "review"];

/** The steps that will actually be shown for this run, e.g. `["agents", "hub", "roots", "review"]` when Claude Code is skipped. */
function numberedStepsForRun(state: WizardState): WizardStep[] {
  return NUMBERED_STEPS.filter((step) => step !== "claude" || claudeStepNeeded(state));
}

/** `[ Setup · Agents 1/5 ]`-style progress title: `n/total` over only the steps this run will show; `apply`/`done` render unnumbered. */
function panelTitle(state: WizardState): string {
  const title = STEP_TITLES[state.step];
  const steps = numberedStepsForRun(state);
  const index = steps.indexOf(state.step);
  return index === -1 ? `Setup · ${title}` : `Setup · ${title} ${index + 1}/${steps.length}`;
}

const AGENT_TITLES: Record<AgentId, string> = {
  pi: "pi",
  "gentle-shell": "gentle-shell",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** The Agents checklist row's note: presence/configured state for pi/gentle-shell/Claude Code (always checkable), or why an agent with no adapter yet (Codex/OpenCode, always disabled) can't be. */
function agentNote(agent: AgentStatus, homeDir: string): string {
  if (!agent.adapterAvailable) return agent.present ? "no adapter yet" : "not installed";
  return agent.configured ? `configured (${shortenHome(agent.detail, homeDir)})` : "not configured";
}

const REVIEW_FIXED_COLUMNS_WIDTH = 30 + 1 + 2 + 2;

function reviewColumns(panelWidth: number): TableColumn<WizardAction>[] {
  const labelWidth = Math.max(panelWidth - REVIEW_FIXED_COLUMNS_WIDTH, 20);
  return [
    { key: "label", header: "action", width: labelWidth },
    { key: "file", header: "file", width: 30 },
  ];
}

function reviewCell(row: WizardAction, key: string): string {
  return key === "file" ? row.file : row.label;
}

function applyResultLine(result: ApplyResult): string {
  if (result.outcome === "error") return `error: ${result.detail ?? result.action.label}`;
  const detail = result.detail ? ` (${result.detail})` : "";
  return `${result.outcome} ${result.action.file}${detail}`;
}

/**
 * Detection is folded into the Agents checklist itself (R1): each row's
 * label already carries the agent's presence/configured state, e.g.
 * `pi — configured (~/.pi/agent/settings.json)` or `gentle-shell — not
 * configured`; disabled rows (no adapter yet) read `Codex — no adapter
 * yet` or `OpenCode — not installed`. `note` is left unset so `Checklist`
 * never appends its own `(note)` suffix on top.
 */
function agentChecklistItems(agents: AgentStatus[], selected: Record<AgentId, boolean>, homeDir: string): ChecklistItem[] {
  return agents.map((agent) => ({
    id: agent.id,
    label: `${AGENT_TITLES[agent.id]} — ${agentNote(agent, homeDir)}`,
    checked: selected[agent.id] === true,
    disabled: !agent.adapterAvailable,
  }));
}

const HUB_MODE_OPTIONS: RadioOption<HubMode>[] = [
  { value: "existing", label: "use an existing hub" },
  { value: "local", label: "install locally" },
  { value: "skip", label: "skip" },
];

function healthLine(healthOk: boolean | undefined, checking: boolean): string {
  if (checking) return "checking…";
  if (healthOk === undefined) return "";
  return healthOk ? "health ok" : "health failed";
}

/**
 * `kankaku setup`'s interactive wizard: one full-screen step at a time,
 * driven by `domain/setup-wizard.ts`'s pure reducers. Unlike every other
 * screen it renders its own header/panel/footer frame directly instead of
 * `ui/layout.tsx`'s `Layout` — there is no sidebar to show, since the
 * wizard's progress lives in the panel's own title instead (`panelTitle`,
 * e.g. `Setup · Agents 1/5`, numbering only the steps this run will
 * actually show — Claude Code is dropped when it isn't needed). Enter
 * advances (validating first), Esc goes back (quits from Agents, the
 * first step, via `onQuit`); `q` quits from anywhere a text field isn't
 * currently capturing keystrokes.
 */
export function SetupWizard({ facts, actions, onDone, onQuit, version, columns, rows }: SetupWizardProps) {
  const theme = useTheme();
  const [state, setState] = useState<WizardState>(() => createWizardState(facts));
  const [agentCursor, setAgentCursor] = useState(0);
  const [hubFocus, setHubFocus] = useState(0);
  const [healthChecking, setHealthChecking] = useState(false);
  const [rootsText, setRootsText] = useState(() => state.roots.join(", "));
  const applyStartedRef = useRef(false);

  useEffect(() => {
    if (state.step === "hub") setHubFocus(0);
  }, [state.step]);

  const hubFieldCount = state.hub.mode === "existing" ? 4 : state.hub.mode === "local" ? 3 : 1;
  const textInputFocused =
    state.step === "claude" || state.step === "roots" || (state.step === "hub" && hubFocus >= 1 && hubFocus < hubFieldCount);

  useEffect(() => {
    if (state.step !== "apply" || applyStartedRef.current) return;
    applyStartedRef.current = true;
    const snapshot = state;
    void (async () => {
      for (const action of snapshot.plan) {
        const result = await actions.apply(action, snapshot);
        setState((s) => applyResult(s, result));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step]);

  useInput((input, key) => {
    if (key.tab && state.step === "hub") {
      setHubFocus((current) => (current + 1) % hubFieldCount);
      return;
    }

    if (key.return) {
      if (state.step === "done") {
        onDone();
        return;
      }
      setState((s) => next(s, facts));
      return;
    }

    if (key.escape) {
      if (state.step === "agents") {
        onQuit();
        return;
      }
      setState((s) => back(s));
      return;
    }

    if (!textInputFocused && input === "q") {
      onQuit();
      return;
    }

    if (state.step === "hub" && state.hub.mode === "existing" && !textInputFocused) {
      if (input === "c") {
        setHealthChecking(true);
        void actions.checkHealth(state.hub.url).then((ok) => {
          setState((s) => setHubHealth(s, ok));
          setHealthChecking(false);
        });
        return;
      }
    }
  });

  const hints = hintsForStep(state.step);

  const { stdout } = useStdout();
  const width = columns ?? stdout?.columns ?? 80;
  const height = rows ?? stdout?.rows ?? DEFAULT_ROWS;
  const mainWidth = width;
  const mainHeight = Math.max(height - HEADER_ROWS - FOOTER_ROWS, 0);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <HeaderBar left={`>_ kankaku setup${version ? ` ${version}` : ""}`} width={width} />
      <Box flexDirection="column" flexGrow={1} minHeight={0}>
        <Panel title={panelTitle(state)} width={mainWidth} height={mainHeight} active>
          {state.step === "agents" && (
            <Checklist
              items={agentChecklistItems(state.agents, state.selected, facts.homeDir)}
              cursor={agentCursor}
              onToggle={(id) => setState((s) => toggleAgent(s, id as AgentId))}
              onMove={(delta) => setAgentCursor((c) => Math.min(Math.max(c + delta, 0), state.agents.length - 1))}
              focused
            />
          )}

          {state.step === "claude" && (
            <Box flexDirection="column">
              <Text>kankaku-claude checkout path:</Text>
              <TextInput value={state.claudeCheckout} onChange={(value) => setState((s) => setClaudeCheckout(s, value))} focused />
              {state.errors.claudeCheckout && <Text color={theme.error}>{state.errors.claudeCheckout}</Text>}
            </Box>
          )}

          {state.step === "hub" && (
            <Box flexDirection="column">
              <Radio options={HUB_MODE_OPTIONS} value={state.hub.mode} onChange={(mode) => setState((s) => setHubMode(s, mode))} focused={hubFocus === 0} />
              {state.hub.mode === "existing" && (
                <Box flexDirection="column">
                  {(["url", "email", "password"] as HubField[]).map((field, index) => (
                    <Box key={field} flexDirection="row">
                      <Text>{`${field}: `}</Text>
                      <TextInput
                        value={state.hub[field]}
                        onChange={(value) => setState((s) => setHubField(s, field, value))}
                        masked={field === "password"}
                        focused={hubFocus === index + 1}
                      />
                    </Box>
                  ))}
                  {state.errors.url && <Text color={theme.error}>{state.errors.url}</Text>}
                  {state.errors.email && <Text color={theme.error}>{state.errors.email}</Text>}
                  {state.errors.password && <Text color={theme.error}>{state.errors.password}</Text>}
                  <Text>{`[ check ] c   ${healthLine(state.hub.healthOk, healthChecking)}`}</Text>
                </Box>
              )}
              {state.hub.mode === "local" && (
                <Box flexDirection="column">
                  <Text dimColor>{`will install and run at http://127.0.0.1:${DEFAULT_HUB_PORT}`}</Text>
                  <Box flexDirection="row">
                    <Text>{"owner email: "}</Text>
                    <TextInput value={state.hub.ownerEmail} onChange={(value) => setState((s) => setHubField(s, "ownerEmail", value))} focused={hubFocus === 1} />
                  </Box>
                  <Box flexDirection="row">
                    <Text>{"owner password: "}</Text>
                    <TextInput value={state.hub.ownerPassword} onChange={(value) => setState((s) => setHubField(s, "ownerPassword", value))} masked focused={hubFocus === 2} />
                  </Box>
                  {state.errors.ownerEmail && <Text color={theme.error}>{state.errors.ownerEmail}</Text>}
                  {state.errors.ownerPassword && <Text color={theme.error}>{state.errors.ownerPassword}</Text>}
                </Box>
              )}
            </Box>
          )}

          {state.step === "roots" && (
            <Box flexDirection="column">
              <Text>project roots (comma-separated):</Text>
              <TextInput
                value={rootsText}
                onChange={(value) => {
                  setRootsText(value);
                  setState((s) => setRoots(s, value));
                }}
                focused
              />
              {state.errors.roots && <Text color={theme.error}>{state.errors.roots}</Text>}
            </Box>
          )}

          {state.step === "review" && (
            <Table columns={reviewColumns(mainWidth)} rows={state.plan} rowKey={(row) => `${row.kind}-${row.file}`} cell={reviewCell} emptyText="nothing to change" />
          )}

          {state.step === "apply" && (
            <Box flexDirection="column">
              {state.results.map((result, index) => (
                <Text key={`${result.action.kind}-${index}`}>{applyResultLine(result)}</Text>
              ))}
              {state.results.length < state.plan.length && <Text dimColor>applying…</Text>}
            </Box>
          )}

          {state.step === "done" && (
            <Box flexDirection="column">
              <Text>{`setup complete: ${state.results.length} change(s) applied`}</Text>
              <Text dimColor>enter open dashboard</Text>
            </Box>
          )}
        </Panel>
      </Box>
      <KeyHints hints={hints} />
    </Box>
  );
}
