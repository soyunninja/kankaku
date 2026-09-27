import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  applyResult,
  back,
  createWizardState,
  hintsForStep,
  next,
  planFromWizard,
  setClaudeCheckout,
  setHubField,
  setHubHealth,
  setHubLocalManual,
  setHubMode,
  setLocalCheckout,
  setRoots,
  toggleAgent,
} from "../../domain/setup-wizard.ts";
import type { ApplyResult, HubField, HubMode, WizardAction, WizardFacts, WizardState, WizardStep } from "../../domain/setup-wizard.ts";
import type { AgentId, AgentStatus } from "../../domain/setup-plan.ts";
import { Layout } from "../layout.tsx";
import type { SidebarItem } from "../components/sidebar.tsx";
import { Panel } from "../components/panel.tsx";
import { Table } from "../components/table.tsx";
import type { TableColumn } from "../components/table.tsx";
import { Checklist } from "../components/checklist.tsx";
import type { ChecklistItem } from "../components/checklist.tsx";
import { Radio } from "../components/radio.tsx";
import type { RadioOption } from "../components/radio.tsx";
import { TextInput } from "../components/text-input.tsx";
import { useTheme } from "../theme.ts";

/**
 * The wizard's own dependency surface, built by `cli.tsx` from the real
 * `adapters/setup/*` writers: `apply` carries the current `WizardState`
 * alongside the plan `WizardAction`, since several actions (`write-claude`,
 * `write-hub`, `write-roots`) need a value that never made it into the
 * action itself (see `domain/setup-wizard.ts#planFromWizard` — `file` is
 * always the target path, never the checkout/credentials/roots to write).
 * `installLocalHub` is exposed here for interface completeness (mirroring
 * every other real adapter this wizard drives) but is only ever invoked
 * from within `apply`'s own `install-local-hub` handling; the UI itself
 * only ever calls `apply`.
 */
export interface WizardActions {
  apply(action: WizardAction, state: WizardState): Promise<ApplyResult>;
  checkHealth(url: string): Promise<boolean>;
  findHubCheckout(): string | undefined;
  manualCommands(checkout?: string): string[];
  installLocalHub(checkout: string): Promise<{ url: string; serviceEmail: string; servicePassword: string }>;
}

export interface SetupWizardProps {
  facts: WizardFacts;
  actions: WizardActions;
  /** Called once, from the Done step, when Enter is pressed. */
  onDone: () => void;
  /** Called from the Detect step when Esc is pressed (the wizard's own quit). */
  onQuit: () => void;
  /** Shown in the header bar, matching every other screen. Omitted in a standalone render. */
  version?: string;
  columns?: number;
  rows?: number;
}

/** The seven steps shown in the sidebar; `apply` has no entry of its own (it is the Review step's own execution, not a step the user navigates to). */
const SIDEBAR_STEPS: WizardStep[] = ["detect", "agents", "claude", "hub", "roots", "review", "done"];

const STEP_TITLES: Record<WizardStep, string> = {
  detect: "Detect",
  agents: "Agents",
  claude: "Claude",
  hub: "Hub",
  roots: "Roots",
  review: "Review",
  apply: "Apply",
  done: "Done",
};

const AGENT_TITLES: Record<AgentId, string> = {
  pi: "pi",
  "gentle-shell": "gentle-shell",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** The sidebar's own active id: `apply` has no sidebar row, so it maps to `review` (the step it is executing). */
function sidebarActiveId(step: WizardStep): WizardStep {
  return step === "apply" ? "review" : step;
}

function wizardSidebarItems(step: WizardStep): SidebarItem[] {
  const activeIndex = SIDEBAR_STEPS.indexOf(sidebarActiveId(step));
  return SIDEBAR_STEPS.map((entry, index) => ({
    id: entry,
    key: String(index + 1),
    label: index < activeIndex ? `✓ ${STEP_TITLES[entry]}` : STEP_TITLES[entry],
  }));
}

function agentStateLabel(agent: AgentStatus): string {
  if (!agent.adapterAvailable) return "no adapter";
  if (!agent.present) return "not found";
  return agent.configured ? "configured" : "present";
}

const DETECT_FIXED_COLUMNS_WIDTH = 14 + 1 + 12 + 1 + 2 + 2;

function detectColumns(panelWidth: number): TableColumn<AgentStatus>[] {
  const detailWidth = Math.max(panelWidth - DETECT_FIXED_COLUMNS_WIDTH, 10);
  return [
    { key: "agent", header: "agent", width: 14 },
    { key: "state", header: "state", width: 12 },
    { key: "detail", header: "detail", width: detailWidth },
  ];
}

function detectCell(row: AgentStatus, key: string): string {
  switch (key) {
    case "agent":
      return AGENT_TITLES[row.id];
    case "state":
      return agentStateLabel(row);
    case "detail":
      return row.detail;
    default:
      return "";
  }
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

function agentChecklistItems(agents: AgentStatus[], selected: Record<AgentId, boolean>): ChecklistItem[] {
  return agents.map((agent) => {
    const disabled = agent.id === "codex" || agent.id === "opencode";
    return {
      id: agent.id,
      label: AGENT_TITLES[agent.id],
      checked: selected[agent.id] === true,
      disabled,
      note: disabled ? "no adapter yet" : undefined,
    };
  });
}

const HUB_MODE_OPTIONS: RadioOption<HubMode>[] = [
  { value: "existing", label: "use an existing hub" },
  { value: "local", label: "install locally" },
  { value: "skip", label: "skip" },
];

/** Mirrors `adapters/setup/local-hub.ts`'s own `HUB_URL`: where a manually-started local hub is expected to answer. */
const LOCAL_HUB_URL = "http://127.0.0.1:8090";

function healthLine(healthOk: boolean | undefined, checking: boolean): string {
  if (checking) return "checking…";
  if (healthOk === undefined) return "";
  return healthOk ? "health ok" : "health failed";
}

/**
 * `kankaku setup`'s interactive wizard: one full-screen step at a time
 * inside the shared `Layout` frame, driven by `domain/setup-wizard.ts`'s
 * pure reducers. Enter advances (validating first), Esc goes back (quits
 * from Detect, via `onQuit`); `q` quits from anywhere a text field isn't
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

  const foundCheckout = state.hub.mode === "local" ? actions.findHubCheckout() : undefined;
  const hasCheckoutField = state.hub.mode === "local" && (state.hub.localCheckout.trim() !== "" || foundCheckout !== undefined);
  const checkoutValue = state.hub.localCheckout.trim() !== "" ? state.hub.localCheckout : (foundCheckout ?? "");

  const hubFieldCount = state.hub.mode === "existing" ? 4 : state.hub.mode === "local" && hasCheckoutField ? 2 : 1;
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
      if (state.step === "detect") {
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

    if (state.step === "hub" && !textInputFocused) {
      if (input === "c") {
        const url = state.hub.mode === "existing" ? state.hub.url : LOCAL_HUB_URL;
        setHealthChecking(true);
        void actions.checkHealth(url).then((ok) => {
          setState((s) => setHubHealth(s, ok));
          setHealthChecking(false);
        });
        return;
      }
      if (input === "m" && state.hub.mode === "local" && !hasCheckoutField) {
        setState((s) => setHubLocalManual(s, true));
        return;
      }
    }
  });

  const stepTitle = STEP_TITLES[state.step];
  const hints = hintsForStep(state.step);

  return (
    <Layout
      columns={columns}
      rows={rows}
      headerLeft={`>_ kankaku setup${version ? ` ${version}` : ""}`}
      sidebarItems={wizardSidebarItems(state.step)}
      activeId={sidebarActiveId(state.step)}
      sidebarStats={[]}
      keyHints={hints}
      focus="main"
    >
      {({ mainWidth, mainHeight }) => (
        <Panel title={`Setup · ${stepTitle}`} width={mainWidth} height={mainHeight} active>
          {state.step === "detect" && (
            <Table columns={detectColumns(mainWidth)} rows={state.agents} rowKey={(row) => row.id} cell={detectCell} emptyText="no agents detected" />
          )}

          {state.step === "agents" && (
            <Checklist
              items={agentChecklistItems(state.agents, state.selected)}
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
              {state.hub.mode === "local" && hasCheckoutField && (
                <Box flexDirection="column">
                  <Text>local checkout path:</Text>
                  <TextInput value={checkoutValue} onChange={(value) => setState((s) => setLocalCheckout(s, value))} focused={hubFocus === 1} />
                </Box>
              )}
              {state.hub.mode === "local" && !hasCheckoutField && (
                <Box flexDirection="column">
                  <Text dimColor>no kankaku-hub checkout found; run these commands, then check again:</Text>
                  {actions.manualCommands(state.hub.localCheckout || undefined).map((line) => (
                    <Text key={line}>{`  ${line}`}</Text>
                  ))}
                  <Text>{`[ check again ] c   ${healthLine(state.hub.healthOk, healthChecking)}`}</Text>
                  <Text>{`[ m ] acknowledge manual install${state.hub.localManual ? " (acknowledged)" : ""}`}</Text>
                  {state.errors.localCheckout && <Text color={theme.error}>{state.errors.localCheckout}</Text>}
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
      )}
    </Layout>
  );
}
