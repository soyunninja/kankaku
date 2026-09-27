#!/usr/bin/env node
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { render } from "ink";
import { buildTasks, localDay } from "kankaku/domain";
import type { TaskView } from "kankaku/domain";
import { buildSyncStatusLines, formatCatalogRefreshLines, formatSyncSummaryLines, formatTasks } from "kankaku/hub";
import type { HubCredentials } from "kankaku/hub";
import { readTuiConfig } from "./adapters/tui-config.ts";
import { discoverProjects } from "./adapters/project-discovery.ts";
import { readProjectRecords } from "./adapters/worklog-reader.ts";
import { computeProjectSyncStatus, createCatalog, refreshCatalog as refreshCatalogAdapter, resolveHub, syncProject } from "./adapters/hub.ts";
import { readOwnVersion } from "./adapters/app-info.ts";
import { buildCatalogModel } from "./domain/catalog-model.ts";
import { buildTodayRows, formatTodayLines } from "./domain/today-model.ts";
import type { TodayModel } from "./domain/today-model.ts";
import { buildDashboardModel } from "./domain/dashboard-model.ts";
import type { DashboardHubInput, DashboardModel } from "./domain/dashboard-model.ts";
import type { ProjectRef } from "./ports/project-source.ts";
import { App } from "./ui/app.tsx";
import type { DashboardActions } from "./ui/dashboard-screen.tsx";
import type { CatalogScreenProps } from "./ui/catalog-screen.tsx";
import type { TasksModel } from "./domain/tasks-model.ts";
import { buildTasksModel } from "./domain/tasks-model.ts";
import { buildSyncRows } from "./domain/sync-model.ts";
import type { SyncModel, SyncScreenProps } from "./ui/sync-screen.tsx";
import { DEFAULT_THEME, ThemeProvider, resolveTheme } from "./ui/theme.ts";
import type { Theme } from "./ui/theme.ts";
import { detectAgents, formatDoctorLines, formatSetupPlanLines, planSetup } from "./domain/setup-plan.ts";
import type { AgentStatus, HubPlanFacts, TuiPlanFacts } from "./domain/setup-plan.ts";
import type { ApplyResult, WizardAction, WizardFacts, WizardState } from "./domain/setup-wizard.ts";
import { readAgentFacts } from "./adapters/setup/agents.ts";
import { addKankakuPackage, removeKankakuPackage } from "./adapters/setup/pi.ts";
import { removeStatusLine, writeStatusLine } from "./adapters/setup/claude.ts";
import { checkHubHealth, credentialsPath, writeHubCredentials } from "./adapters/setup/hub.ts";
import { tuiConfigPath, writeTuiConfig } from "./adapters/setup/tui-config.ts";
import { findHubCheckout, installLocalHub, manualCommands } from "./adapters/setup/local-hub.ts";
import { createChildProcessRunner } from "./adapters/setup/child-process-runner.ts";
import { createReadlinePrompter } from "./adapters/setup/readline-prompter.ts";
import type { Prompter } from "./ports/prompter.ts";
import type { WizardActions } from "./ui/setup/wizard-screen.tsx";

export interface CliDeps {
  homeDir: string;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
  renderApp: (roots: string[], theme: Theme, options?: { startInWizard?: boolean }) => void;
  /** Whether stdout is a real terminal; drives `kankaku setup`'s TTY-vs-readline split. Injectable for tests; defaults to `false` when omitted, so every existing test keeps exercising the readline flow. */
  isTTY?: () => boolean;
  /** Injectable for tests; defaults to `process.env` at the real entry point. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to `Date.now` at the real entry point. */
  now?: () => number;
  /** Injectable for tests; defaults to `os.hostname` at the real entry point. */
  hostname?: () => string;
  /** Injectable for tests; defaults to the global `fetch` at the real entry point. */
  fetch?: typeof fetch;
  /** Drives `setup`'s interactive prompts; defaults to `readline-prompter.ts` over stdin/stdout at the real entry point. Never called by `--yes` or `--dry-run`. */
  prompter?: Prompter;
}

const USAGE =
  "usage: kankaku [today|tasks [--all]|catalog [refresh]|sync [status|all] [--project <dir>]|setup [--yes] [--dry-run]|doctor] [--roots a,b] [--theme name]\n";

/** Load today's model for `roots`: discover projects, read their worklogs, build rows. */
export function loadToday(roots: string[]): TodayModel {
  const projects = discoverProjects(roots);
  const withRecords = projects.map((project) => ({ name: project.name, records: readProjectRecords(project) }));
  return buildTodayRows(withRecords);
}

/** Load the Tasks screen's model for `roots`: same project/record discovery as `loadToday`, restricted to today unless `options.all`. */
export function loadTasks(roots: string[], options: { all: boolean }): TasksModel {
  const projects = discoverProjects(roots);
  const withRecords = projects.map((project) => ({ name: project.name, records: readProjectRecords(project) }));
  return buildTasksModel(withRecords, options);
}

/**
 * Load the Today screen's dashboard model: every project's records (kept
 * whole — `dashboard-model.ts` derives both today's rows and the last 7
 * days from the same set, so nothing extra is read beyond what
 * `readProjectRecords` already loads), plus the Hub card from local
 * no-network sync status and the cached catalog. Without hub credentials,
 * or with no catalog cached yet, the Hub card degrades to `"unavailable"`
 * without touching the network.
 */
export function loadDashboard(roots: string[], deps: CliDeps): DashboardModel {
  const projects = discoverProjects(roots);
  const withRecords = projects.map((project) => ({ name: project.name, records: readProjectRecords(project) }));
  const { now } = envDeps(deps);
  const today = localDay(new Date(now()).toISOString());

  const hub = resolveHub({ env: deps.env ?? {}, homeDir: () => deps.homeDir });
  if (!hub.ok) {
    return buildDashboardModel(withRecords, undefined, undefined, { today });
  }

  const { fetch: fetchOverride } = envDeps(deps);
  const hubEntries: DashboardHubInput[] = projects.map((project) => ({
    name: project.name,
    status: computeProjectSyncStatus(project, hub.credentials, deps.env ?? {}),
  }));
  const catalog = createCatalog(hub.credentials, { homeDir: () => deps.homeDir, now, ...(fetchOverride ? { fetch: fetchOverride } : {}) });
  const catalogModel = buildCatalogModel(catalog.read(), now());
  const catalogSummary =
    catalogModel.status === "ready"
      ? { url: catalogModel.url, clientCount: catalogModel.clients.length, projectCount: catalogModel.clients.reduce((sum, client) => sum + client.projects.length, 0) }
      : undefined;

  return buildDashboardModel(withRecords, hubEntries, catalogSummary, { today });
}

function parseRoots(argv: string[], deps: Pick<CliDeps, "homeDir" | "cwd">): { roots: string[]; rest: string[] } {
  const flagIndex = argv.indexOf("--roots");
  if (flagIndex === -1) {
    return { roots: readTuiConfig(deps.homeDir, deps.cwd).roots, rest: argv };
  }
  const value = argv[flagIndex + 1] ?? "";
  const roots = value.split(",").filter((root) => root.length > 0);
  const rest = [...argv.slice(0, flagIndex), ...argv.slice(flagIndex + 2)];
  return { roots, rest };
}

/** Strip `--theme <name>` from `argv` (present anywhere), returning its value (if any) and the rest. */
function parseThemeFlag(argv: string[]): { theme: string | undefined; rest: string[] } {
  const flagIndex = argv.indexOf("--theme");
  if (flagIndex === -1) return { theme: undefined, rest: argv };
  const value = argv[flagIndex + 1];
  const rest = [...argv.slice(0, flagIndex), ...argv.slice(flagIndex + 2)];
  return { theme: value, rest };
}

function parseProjectFlag(argv: string[], cwd: string): { project: string | undefined; rest: string[] } {
  const flagIndex = argv.indexOf("--project");
  if (flagIndex === -1) return { project: undefined, rest: argv };
  const value = argv[flagIndex + 1];
  const rest = [...argv.slice(0, flagIndex), ...argv.slice(flagIndex + 2)];
  return { project: value !== undefined ? resolve(cwd, value) : undefined, rest };
}

function envDeps(deps: CliDeps): { env: NodeJS.ProcessEnv; homeDir: () => string; now: () => number; hostname: () => string; fetch?: typeof fetch } {
  return {
    env: deps.env ?? {},
    homeDir: () => deps.homeDir,
    now: deps.now ?? (() => Date.now()),
    hostname: deps.hostname ?? (() => hostname()),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
}

/** Filter `tasks` to `day` (local calendar day), or return every task when `day` is `undefined`. */
function filterTasksForDay(tasks: TaskView[], day: string | undefined): TaskView[] {
  return day === undefined ? tasks : tasks.filter((task) => localDay(task.startedAt) === day);
}

/** `kankaku tasks [--all]`: kankaku's own `formatTasks` output per project, prefixed by a `== <project> ==` header. */
function runTasksCommand(args: string[], roots: string[], deps: CliDeps): void {
  const all = args.includes("--all");
  const targetDay = all ? undefined : localDay(new Date().toISOString());
  const projects = discoverProjects(roots);

  const blocks: string[] = [];
  for (const project of projects) {
    const tasks = filterTasksForDay(buildTasks(readProjectRecords(project)), targetDay);
    if (tasks.length === 0) continue;
    blocks.push(`== ${project.name} ==\n${formatTasks(tasks)}`);
  }
  deps.stdout(blocks.length > 0 ? blocks.join("\n\n") : "no tasks");
}

/** `kankaku catalog [refresh]`. Without hub credentials: a one-line note, exit 0. With credentials: `refresh` fetches over the network (exit 1 on failure); without `refresh`, only the local cache is read (no network) and reported. */
async function runCatalogCommand(args: string[], deps: CliDeps): Promise<void> {
  const hub = resolveHub({ env: deps.env ?? {}, homeDir: () => deps.homeDir });
  const doRefresh = args[0] === "refresh";

  if (!hub.ok) {
    if (doRefresh) {
      deps.stderr(`kankaku catalog refresh: ${hub.reason}\n`);
      deps.exit(1);
    } else {
      deps.stdout(hub.reason);
    }
    return;
  }

  const { now, fetch: fetchOverride } = envDeps(deps);
  const catalog = createCatalog(hub.credentials, { homeDir: () => deps.homeDir, now, ...(fetchOverride ? { fetch: fetchOverride } : {}) });

  if (doRefresh) {
    const snapshot = await refreshCatalogAdapter(catalog);
    deps.stdout(formatCatalogRefreshLines(snapshot).join("\n"));
    if (!snapshot) deps.exit(1);
    return;
  }

  const model = buildCatalogModel(catalog.read(), now());
  if (model.status === "unavailable") {
    deps.stdout("no catalog cached yet; run 'kankaku catalog refresh'");
    return;
  }
  const clientCount = model.clients.length;
  const projectCount = model.clients.reduce((sum, client) => sum + client.projects.length, 0);
  deps.stdout(`${model.url}: ${clientCount} client(s), ${projectCount} project(s)${model.stale ? " (stale)" : ""}`);
}

/** Resolve the target projects for `sync`: `--project <dir>` restricts to exactly that directory; otherwise every discovered project under `roots`. */
function resolveTargetProjects(roots: string[], projectFlag: string | undefined): ProjectRef[] {
  if (projectFlag !== undefined) {
    return [{ name: projectFlag.split(/[\\/]/).filter(Boolean).pop() ?? projectFlag, dir: projectFlag }];
  }
  return discoverProjects(roots);
}

/** `kankaku sync [status|all] [--project <dir>]`. Without hub credentials: a one-line note for `status` (exit 0), an error for an actual sync attempt (exit 1). */
async function runSyncCommand(args: string[], roots: string[], deps: CliDeps): Promise<void> {
  const { project: projectFlag, rest } = parseProjectFlag(args, deps.cwd);
  const mode = rest[0] === "status" || rest[0] === "all" ? rest[0] : undefined;
  const hub = resolveHub({ env: deps.env ?? {}, homeDir: () => deps.homeDir });
  const targets = resolveTargetProjects(roots, projectFlag);

  if (!hub.ok) {
    if (mode === "status") {
      deps.stdout(hub.reason);
    } else {
      deps.stderr(`kankaku sync: ${hub.reason}\n`);
      deps.exit(1);
    }
    return;
  }

  if (mode === "status") {
    const blocks = targets.map((project) => {
      const status = computeProjectSyncStatus(project, hub.credentials, deps.env ?? {});
      return `== ${project.name} ==\n${buildSyncStatusLines(status).join("\n")}`;
    });
    deps.stdout(blocks.join("\n\n"));
    return;
  }

  const runnerDeps = envDeps(deps);
  let failed = false;
  const blocks: string[] = [];
  for (const project of targets) {
    const summary = await syncProject(project, hub.credentials, { full: mode === "all" }, runnerDeps);
    if (summary.locked || summary.error !== undefined || summary.failed.length > 0) failed = true;
    blocks.push(`== ${project.name} ==\n${formatSyncSummaryLines(summary).join("\n")}`);
  }
  deps.stdout(blocks.join("\n\n"));
  if (failed) deps.exit(1);
}

/**
 * Gather the plain facts `domain/setup-plan.ts` needs: every detected
 * agent, hub credentials/health, and whether `tui.json` exists. Read-only;
 * the hub health check (bounded to 5s) is the only network call.
 */
async function gatherSetupFacts(deps: CliDeps): Promise<{ agents: AgentStatus[]; hub: HubPlanFacts; tui: TuiPlanFacts }> {
  const agents = detectAgents(readAgentFacts(deps.homeDir));

  const hubResolution = resolveHub({ env: deps.env ?? {}, homeDir: () => deps.homeDir });
  const credPath = credentialsPath(deps.homeDir);
  const hub: HubPlanFacts = hubResolution.ok
    ? {
        credentialsPresent: true,
        url: hubResolution.credentials.url,
        healthOk: await checkHubHealth(hubResolution.credentials.url, { fetch: deps.fetch }),
        credentialsPath: credPath,
      }
    : { credentialsPresent: false, url: undefined, healthOk: undefined, credentialsPath: credPath };

  const tuiPath = tuiConfigPath(deps.homeDir);
  const tui: TuiPlanFacts = { present: existsSync(tuiPath), path: tuiPath };

  return { agents, hub, tui };
}

/** `kankaku doctor`: read-only report, `domain/setup-plan.ts#formatDoctorLines` verbatim. Also run as the last step of `kankaku setup`. */
async function runDoctorCommand(deps: CliDeps): Promise<void> {
  const { agents, hub, tui } = await gatherSetupFacts(deps);
  deps.stdout(formatDoctorLines(agents, hub, tui).join("\n"));
}

/** Plausible `kankaku-hub` checkout locations to probe for the wizard's Hub step: a sibling of this project's parent, and the documented default under the home directory. */
function localHubCandidates(deps: CliDeps): string[] {
  return [join(deps.homeDir, "desarrollo", "soyun.ninja", "kankaku-hub"), join(dirname(deps.cwd), "kankaku-hub")];
}

/**
 * Gather the plain facts the setup wizard needs (`domain/setup-wizard.ts#createWizardState`):
 * every detected agent, current hub credentials (reused as the "existing
 * hub" step's defaults) and current `tui.json` roots. Entirely read-only,
 * with no network call — the hub's health is checked interactively, from
 * the wizard's own Hub step, never upfront.
 */
function gatherWizardFacts(deps: CliDeps): WizardFacts {
  const agentFacts = readAgentFacts(deps.homeDir);
  const hubResolution = resolveHub({ env: deps.env ?? {}, homeDir: () => deps.homeDir });
  const credPath = credentialsPath(deps.homeDir);
  const localCheckoutGuess = findHubCheckout(localHubCandidates(deps)) ?? join(deps.homeDir, "desarrollo", "soyun.ninja", "kankaku-hub");

  const hub: WizardFacts["hub"] = hubResolution.ok
    ? {
        credentialsPresent: true,
        url: hubResolution.credentials.url,
        email: hubResolution.credentials.email,
        password: hubResolution.credentials.password,
        credentialsPath: credPath,
        localCheckoutGuess,
      }
    : { credentialsPresent: false, url: undefined, email: undefined, password: undefined, credentialsPath: credPath, localCheckoutGuess };

  const tuiPath = tuiConfigPath(deps.homeDir);
  const roots: WizardFacts["roots"] = {
    current: existsSync(tuiPath) ? readTuiConfig(deps.homeDir, deps.cwd).roots : undefined,
    defaultRoots: [dirname(deps.cwd)],
    path: tuiPath,
  };

  return { agentFacts, hub, roots };
}

/** Runs `adapters/setup/local-hub.ts#installLocalHub` for real, sharing one `ScriptRunner`/timer setup between the wizard's `installLocalHub` action and `apply`'s own `install-local-hub` handling. */
async function performLocalHubInstall(checkout: string, deps: CliDeps): Promise<{ url: string; serviceEmail: string; servicePassword: string }> {
  const { now, fetch: fetchOverride } = envDeps(deps);
  const result = await installLocalHub(checkout, {
    runner: createChildProcessRunner(),
    homeDir: deps.homeDir,
    fetch: fetchOverride ?? fetch,
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  if (!result.ok) throw new Error(result.error ?? "installing the local hub failed");
  return { url: result.url, serviceEmail: result.serviceEmail!, servicePassword: result.servicePassword! };
}

/**
 * Apply one planned `WizardAction` for real, through the matching
 * `adapters/setup/*` writer. Several kinds need a value `planFromWizard`
 * never put in the action itself (`file` is always the target path, not
 * what to write) — `state` carries it: `state.claudeCheckout` for
 * `write-claude`, `state.hub` for `write-hub`, `state.roots` for
 * `write-roots`. `install-local-hub` runs the real installer, then writes
 * its returned dev-account credentials as the hub, labelling them as dev
 * defaults in the result detail. Never throws: any adapter failure becomes
 * an `"error"` outcome instead.
 */
async function applyWizardAction(action: WizardAction, state: WizardState, deps: CliDeps): Promise<ApplyResult> {
  try {
    switch (action.kind) {
      case "install-pi": {
        const result = addKankakuPackage(action.file);
        return { action, outcome: result.changed ? "wrote" : "unchanged" };
      }
      case "remove-pi": {
        const result = removeKankakuPackage(action.file);
        return { action, outcome: result.changed ? "removed" : "unchanged" };
      }
      case "write-claude": {
        const result = writeStatusLine(action.file, state.claudeCheckout);
        return { action, outcome: result.changed ? "wrote" : "unchanged" };
      }
      case "remove-claude": {
        const result = removeStatusLine(action.file);
        return { action, outcome: result.changed ? "removed" : "unchanged" };
      }
      case "write-hub": {
        const result = writeHubCredentials(deps.homeDir, { url: state.hub.url, email: state.hub.email, password: state.hub.password });
        return { action, outcome: result.changed ? "wrote" : "unchanged" };
      }
      case "install-local-hub": {
        const installed = await performLocalHubInstall(action.file, deps);
        writeHubCredentials(deps.homeDir, { url: installed.url, email: installed.serviceEmail, password: installed.servicePassword });
        return { action, outcome: "started", detail: `running at ${installed.url} (dev defaults: ${installed.serviceEmail} / ${installed.servicePassword})` };
      }
      case "write-roots": {
        const result = writeTuiConfig(deps.homeDir, state.roots);
        return { action, outcome: result.changed ? "wrote" : "unchanged" };
      }
    }
  } catch (error) {
    return { action, outcome: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Build the setup wizard's `WizardActions` for the interactive app: every write goes through the same real `adapters/setup/*` writers `kankaku setup --yes` uses. Used only by `renderApp`. */
function buildWizardActions(deps: CliDeps): WizardActions {
  return {
    apply: (action, state) => applyWizardAction(action, state, deps),
    checkHealth: (url) => checkHubHealth(url, { fetch: deps.fetch }),
    findHubCheckout: () => findHubCheckout(localHubCandidates(deps)),
    manualCommands: (checkout) => manualCommands(checkout),
    installLocalHub: (checkout) => performLocalHubInstall(checkout, deps),
  };
}

/**
 * Extract a plausible kankaku-claude checkout path from an existing
 * `statusLine.command` of the shape `node "<checkout>/src/statusline.ts"`,
 * whatever package it currently points at — used as the `text()` prompt's
 * default. `undefined` when the command doesn't match that shape at all.
 */
function guessClaudeCheckout(existingCommand: string | undefined): string | undefined {
  if (!existingCommand) return undefined;
  const match = /^node\s+"(.+)\/src\/statusline\.ts"$/.exec(existingCommand.trim());
  return match ? match[1] : undefined;
}

/** Answers one question at a time: `--yes` always takes `defaultValue` without touching `prompter`; otherwise a `Prompter` must have been injected. */
function makeAsker(yes: boolean, prompter: Prompter | undefined): Prompter {
  function requirePrompter(): Prompter {
    if (!prompter) throw new Error("kankaku setup: no prompter available (pass --yes or --dry-run, or inject one)");
    return prompter;
  }
  return {
    confirm: (question, defaultValue) => (yes ? Promise.resolve(defaultValue) : requirePrompter().confirm(question, defaultValue)),
    text: (question, defaultValue) => (yes ? Promise.resolve(defaultValue) : requirePrompter().text(question, defaultValue)),
    secret: (question) => (yes ? Promise.resolve("") : requirePrompter().secret(question)),
  };
}

/**
 * `kankaku setup [--yes] [--dry-run]`: detects every agent, prompts (or
 * takes each question's own default with `--yes`) for what to install or
 * configure, writes only what was confirmed, and ends with the same
 * report as `kankaku doctor`. `--dry-run` prints the plan and writes
 * nothing — no prompt is asked and no default is applied.
 */
/** Tell the user what setup just did to a file: nothing is written silently. */
function announceWrite(deps: CliDeps, file: string, result: { changed: boolean }): void {
  deps.stdout(result.changed ? `wrote ${file}` : `unchanged ${file}`);
}

async function runSetupCommand(args: string[], deps: CliDeps): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");

  const initial = await gatherSetupFacts(deps);
  const steps = planSetup(initial.agents, initial.hub, initial.tui);

  if (dryRun) {
    deps.stdout(formatSetupPlanLines(steps).join("\n"));
    return;
  }

  const ask = makeAsker(yes, deps.prompter);
  const byId = Object.fromEntries(steps.map((step) => [step.id, step]));

  for (const agent of initial.agents) {
    if (agent.id === "codex" || agent.id === "opencode") continue;
    const step = byId[agent.id]!;
    if (step.state !== "todo") continue;

    if (agent.id === "claude-code") {
      const doIt = await ask.confirm(`Configure Claude Code's statusLine for kankaku (${step.file})?`, true);
      if (!doIt) continue;
      const guessed = guessClaudeCheckout(readAgentFacts(deps.homeDir).claudeCode?.statusLineCommand) ?? "";
      const checkoutPath = await ask.text("Path to your kankaku-claude checkout", guessed);
      if (checkoutPath !== "") announceWrite(deps, step.file, writeStatusLine(step.file, checkoutPath));
      continue;
    }

    const doIt = await ask.confirm(`Install kankaku in ${step.title} (${step.file})?`, true);
    if (doIt) announceWrite(deps, step.file, addKankakuPackage(step.file));
  }

  if (byId["hub"]!.state === "todo" && !initial.hub.credentialsPresent) {
    const doIt = await ask.confirm("Configure hub credentials now?", false);
    if (doIt) {
      const url = await ask.text("Hub URL", "");
      if (url !== "") {
        const email = await ask.text("Email", "");
        const password = await ask.secret("Password");
        announceWrite(deps, credentialsPath(deps.homeDir), writeHubCredentials(deps.homeDir, { url, email, password }));
      }
    }
  }

  if (byId["tui-config"]!.state === "todo") {
    const defaultRoots = dirname(deps.cwd);
    const doIt = await ask.confirm(`Write TUI roots to ${byId["tui-config"]!.file}?`, true);
    if (doIt) {
      const rootsInput = await ask.text("Roots for the TUI (comma-separated)", defaultRoots);
      const roots = rootsInput
        .split(",")
        .map((root) => root.trim())
        .filter((root) => root.length > 0);
      if (roots.length > 0) announceWrite(deps, tuiConfigPath(deps.homeDir), writeTuiConfig(deps.homeDir, roots));
    }
  }

  const finalHub = resolveHub({ env: deps.env ?? {}, homeDir: () => deps.homeDir });
  if (finalHub.ok) {
    const doRefresh = await ask.confirm("Refresh the hub catalog now?", false);
    if (doRefresh) {
      const { now, fetch: fetchOverride } = envDeps(deps);
      const catalog = createCatalog(finalHub.credentials, { homeDir: () => deps.homeDir, now, ...(fetchOverride ? { fetch: fetchOverride } : {}) });
      const snapshot = await refreshCatalogAdapter(catalog);
      deps.stdout(formatCatalogRefreshLines(snapshot).join("\n"));
    }
  }

  await runDoctorCommand(deps);
}

/**
 * Resolve the `--theme`/`KANKAKU_TUI_THEME` preset (flag wins), defaulting
 * to {@link DEFAULT_THEME} when neither is given. An explicit but unknown
 * name is a usage error, never a silent fallback.
 */
function resolveCliTheme(themeFlag: string | undefined, env: NodeJS.ProcessEnv | undefined): { ok: true; theme: Theme } | { ok: false; reason: string } {
  const requested = themeFlag ?? env?.KANKAKU_TUI_THEME;
  if (requested === undefined) return { ok: true, theme: DEFAULT_THEME };
  return resolveTheme(requested);
}

/** Parse `argv` and run the requested mode against injected `deps`. No logic beyond argv handling belongs here. */
export async function runCli(argv: string[], deps: CliDeps): Promise<void> {
  const { theme: themeFlag, rest: argvAfterTheme } = parseThemeFlag(argv);
  const themeResult = resolveCliTheme(themeFlag, deps.env);
  if (!themeResult.ok) {
    deps.stderr(`kankaku: ${themeResult.reason}\n`);
    deps.exit(1);
    return;
  }
  const theme = themeResult.theme;

  const { roots, rest } = parseRoots(argvAfterTheme, deps);
  const [command] = rest;

  if (command === undefined) {
    // First-run hint: no `tui.json` yet means this machine has never been
    // set up — open straight into the wizard instead of an empty Dashboard.
    const startInWizard = !existsSync(tuiConfigPath(deps.homeDir));
    deps.renderApp(roots, theme, { startInWizard });
    return;
  }

  if (command === "today") {
    const model = loadToday(roots);
    deps.stdout(formatTodayLines(model.rows, model.total).join("\n"));
    return;
  }

  if (command === "tasks") {
    runTasksCommand(rest.slice(1), roots, deps);
    return;
  }

  if (command === "catalog") {
    await runCatalogCommand(rest.slice(1), deps);
    return;
  }

  if (command === "sync") {
    await runSyncCommand(rest.slice(1), roots, deps);
    return;
  }

  if (command === "setup") {
    const setupArgs = rest.slice(1);
    const interactiveTTY = !setupArgs.includes("--yes") && !setupArgs.includes("--dry-run") && (deps.isTTY?.() ?? false);
    if (interactiveTTY) {
      deps.renderApp(roots, theme, { startInWizard: true });
      return;
    }
    await runSetupCommand(setupArgs, deps);
    return;
  }

  if (command === "doctor") {
    await runDoctorCommand(deps);
    return;
  }

  deps.stderr(USAGE);
  deps.exit(1);
}

/** Build the Catalog screen's `load`/`refresh` deps for the interactive app; used only by `renderApp`. */
function catalogScreenDeps(deps: CliDeps): Pick<CatalogScreenProps, "load" | "refresh"> {
  const hub = resolveHub({ env: deps.env ?? {}, homeDir: () => deps.homeDir });
  const { now, fetch: fetchOverride } = envDeps(deps);

  if (!hub.ok) {
    return { load: () => ({ status: "unavailable", reason: hub.reason }), refresh: async () => ({ status: "unavailable", reason: hub.reason }) };
  }

  const catalog = createCatalog(hub.credentials, { homeDir: () => deps.homeDir, now, ...(fetchOverride ? { fetch: fetchOverride } : {}) });
  return {
    load: () => buildCatalogModel(catalog.read(), now()),
    refresh: async () => buildCatalogModel(await refreshCatalogAdapter(catalog), now()),
  };
}

/** Build the Sync screen's `load`/`syncOne`/`syncAll` deps for the interactive app; used only by `renderApp`. */
function syncScreenDeps(deps: CliDeps, roots: string[]): Pick<SyncScreenProps, "load" | "syncOne" | "syncAll"> {
  const hub = resolveHub({ env: deps.env ?? {}, homeDir: () => deps.homeDir });
  const runnerDeps = envDeps(deps);

  if (!hub.ok) {
    const reason = hub.reason;
    return {
      load: (): SyncModel => ({ status: "unavailable", reason }),
      syncOne: async () => ({ ok: false, message: reason }),
      syncAll: async () => [],
    };
  }
  const credentials: HubCredentials = hub.credentials;

  const load = (): SyncModel => {
    const projects = discoverProjects(roots);
    const entries = projects.map((project) => ({ project, status: computeProjectSyncStatus(project, credentials, deps.env ?? {}) }));
    return { status: "ready", rows: buildSyncRows(entries) };
  };

  const findProject = (name: string): ProjectRef | undefined => discoverProjects(roots).find((project) => project.name === name);

  return {
    load,
    syncOne: async (row, options) => {
      const project = findProject(row.name) ?? { name: row.name, dir: row.dir };
      const summary = await syncProject(project, credentials, options, runnerDeps);
      return { ok: summary.error === undefined && summary.failed.length === 0 && !summary.locked, message: formatSyncSummaryLines(summary).join("; ") };
    },
    syncAll: async () => {
      const projects = discoverProjects(roots);
      const results = [];
      for (const project of projects) {
        const summary = await syncProject(project, credentials, {}, runnerDeps);
        results.push({ ok: summary.error === undefined && summary.failed.length === 0 && !summary.locked, message: formatSyncSummaryLines(summary).join("; ") });
      }
      return results;
    },
  };
}

/**
 * Build the Dashboard screen's Quick actions deps for the interactive app:
 * `refreshCatalog` refreshes the cached catalog through `createCatalog`/
 * `refreshCatalogAdapter`, `syncAll` runs `syncProject` over every
 * discovered project — both reuse kankaku's own `formatCatalogRefreshLines`/
 * `formatSyncSummaryLines` for the result message, never reimplementing
 * them. Without hub credentials, `hubAvailable` is `false` and neither
 * function is ever called by the screen. Used only by `renderApp`.
 */
function dashboardActionsDeps(deps: CliDeps, roots: string[]): DashboardActions {
  const hub = resolveHub({ env: deps.env ?? {}, homeDir: () => deps.homeDir });
  if (!hub.ok) {
    const reason = hub.reason;
    return { hubAvailable: false, refreshCatalog: async () => reason, syncAll: async () => reason };
  }
  const credentials: HubCredentials = hub.credentials;
  const runnerDeps = envDeps(deps);
  const { now, fetch: fetchOverride } = envDeps(deps);

  return {
    hubAvailable: true,
    refreshCatalog: async () => {
      const catalog = createCatalog(credentials, { homeDir: () => deps.homeDir, now, ...(fetchOverride ? { fetch: fetchOverride } : {}) });
      const snapshot = await refreshCatalogAdapter(catalog);
      return formatCatalogRefreshLines(snapshot).join(" · ");
    },
    syncAll: async (options) => {
      const projects = discoverProjects(roots);
      if (projects.length === 0) return "no projects to sync";
      const summaries = await Promise.all(projects.map((project) => syncProject(project, credentials, options, runnerDeps)));
      return summaries.flatMap((summary) => formatSyncSummaryLines(summary)).join(" · ");
    },
  };
}

/**
 * Run the entrypoint only when this file is the script Node was started
 * with. npm installs the binary as a symlink (`node_modules/.bin/kankaku ->
 * ../kankaku-tui/dist/cli.js`), so `process.argv[1]` is the link while
 * `import.meta.url` is the real file: compare real paths, or an installed
 * `kankaku` silently does nothing.
 */
function isMainModule(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  let real = script;
  try {
    real = realpathSync(script);
  } catch {
    // A missing or unreadable path cannot be this module; fall through with the literal.
  }
  return import.meta.url === pathToFileURL(real).href;
}

const isMain = isMainModule();

if (isMain) {
  const realDeps: CliDeps = {
    homeDir: homedir(),
    cwd: process.cwd(),
    env: process.env,
    now: () => Date.now(),
    hostname: () => hostname(),
    stdout: (text) => {
      console.log(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    exit: (code) => {
      process.exit(code);
    },
    isTTY: () => process.stdout.isTTY === true,
    prompter: createReadlinePrompter(process.stdin, process.stdout),
    renderApp: (roots, theme, options) => {
      render(
        <ThemeProvider theme={theme}>
          <App
            roots={roots}
            version={readOwnVersion()}
            loadToday={() => loadDashboard(roots, realDeps)}
            loadTasks={(options) => loadTasks(roots, options)}
            catalog={catalogScreenDeps(realDeps)}
            sync={syncScreenDeps(realDeps, roots)}
            dashboardActions={dashboardActionsDeps(realDeps, roots)}
            wizard={{ facts: gatherWizardFacts(realDeps), actions: buildWizardActions(realDeps) }}
            startInWizard={options?.startInWizard}
          />
        </ThemeProvider>,
        { alternateScreen: true, exitOnCtrlC: true },
      );
    },
  };
  void runCli(process.argv.slice(2), realDeps);
}
