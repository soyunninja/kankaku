#!/usr/bin/env node
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { render } from "ink";
import { buildTasks, localDay } from "kankaku-pi/domain";
import type { TaskView } from "kankaku-pi/domain";
import { buildSyncStatusLines, formatCatalogRefreshLines, formatSyncSummaryLines, formatTasks } from "kankaku-pi/hub";
import type { HubCredentials } from "kankaku-pi/hub";
import { readTuiConfig } from "./adapters/tui-config.ts";
import { discoverProjects } from "./adapters/project-discovery.ts";
import { readProjectRecords } from "./adapters/worklog-reader.ts";
import { computeProjectSyncStatus, createCatalog, refreshCatalog as refreshCatalogAdapter, resolveHub, syncProject } from "./adapters/hub.ts";
import { readOwnVersion } from "./adapters/app-info.ts";
import { readCarriedVersions } from "./adapters/package-versions.ts";
import { formatVersionLines } from "./domain/version-info.ts";
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
import { parseHubPort } from "./domain/setup-wizard.ts";
import type { ApplyResult, WizardAction, WizardFacts, WizardState } from "./domain/setup-wizard.ts";
import { readAgentFacts } from "./adapters/setup/agents.ts";
import { addKankakuPackage, removeKankakuPackage } from "./adapters/setup/pi.ts";
import { removeClaudeIntegration, writeClaudeIntegration } from "./adapters/setup/claude.ts";
import { locateClaudePlugin, readPluginHooks } from "./adapters/setup/claude-plugin.ts";
import { commandsDirectory, readPluginCommands, removeClaudeCommands, writeClaudeCommands } from "./adapters/setup/claude-commands.ts";
import type { CommandsWriteResult } from "./adapters/setup/claude-commands.ts";
import { checkHubHealth, credentialsPath, writeHubCredentials } from "./adapters/setup/hub.ts";
import { tuiConfigPath, writeTuiConfig } from "./adapters/setup/tui-config.ts";
import { installLocalHub } from "./adapters/setup/local-hub.ts";
import { createChildProcessRunner } from "./adapters/setup/child-process-runner.ts";
import { createReadlinePrompter } from "./adapters/setup/readline-prompter.ts";
import type { Prompter } from "./ports/prompter.ts";
import type { WizardActions } from "./ui/setup/wizard-screen.tsx";
import { describeSyncTarget, hubLayout, parseHubConfig } from "./domain/local-hub-model.ts";
import type { HubStatus } from "./domain/local-hub-model.ts";
import { hubLogs, hubStatus, installHub, startHub, stopHub, upgradeHub } from "./adapters/hub-manager/install.ts";
import type { HubManagerDeps } from "./adapters/hub-manager/install.ts";
import { isAlive, readPid, startDetached } from "./adapters/hub-manager/process.ts";
import { locateHubPackage } from "./adapters/hub-manager/package.ts";
import { useLocalHub } from "./adapters/hub-manager/credentials.ts";
import { firstFreePort, isPortFree, realPortBinder } from "./adapters/hub-manager/port-probe.ts";
import type { PortBinder } from "./adapters/hub-manager/port-probe.ts";

export interface CliDeps {
  homeDir: string;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
  renderApp: (roots: string[], theme: Theme, options?: { startInWizard?: boolean; claudePluginDir?: string }) => void;
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
  /** Overrides for `hub-manager/install.ts`'s injectable dependencies (`runner`, `startDetached`, `randomBytes`, `locatePackage`, `platform`, `arch`); tests inject fakes here so `kankaku hub *` never spawns a real PocketBase or touches the real package. Defaults to the real adapters at the real entry point. */
  hubManager?: Partial<HubManagerDeps>;
  /** Resolves `<package>/package.json` for `kankaku --version`; defaults to `require.resolve`. Tests inject one to simulate a missing package. */
  resolvePackage?: (specifier: string) => string;
}

const USAGE =
  "usage: kankaku [--version|-v|version|today|tasks [--all]|catalog [refresh]|sync [status|all] [--project <dir>]|setup [--yes] [--dry-run] [--from-checkout <dir>] [--claude-plugin-dir <dir>]|doctor|hub install [--port N] [--owner-email E] [--owner-password P]|hub use|hub start|hub stop|hub status|hub upgrade|hub logs [-n N]] [--roots a,b] [--theme name]\n";

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
 * Detects whether the resolved hub credentials point at this machine's
 * own local hub install (`~/.kankaku/hub/hub.json` exists and its
 * `hub.json` port matches the credentials' `http://127.0.0.1:<port>`),
 * and if so, whether its process is currently alive — via pid liveness
 * only (`hub-manager/process.ts#isAlive`), never a network call, so the
 * Dashboard's load stays no-network exactly like every other local-only
 * fact it already reads.
 */
function detectLocalHub(deps: CliDeps, hubUrl: string): "running" | "stopped" | undefined {
  const layout = hubLayout(deps.homeDir);
  if (!existsSync(layout.hubJson)) return undefined;
  let config;
  try {
    config = parseHubConfig(JSON.parse(readFileSync(layout.hubJson, "utf8")));
  } catch {
    return undefined;
  }
  if (hubUrl !== `http://127.0.0.1:${config.port}`) return undefined;
  const pid = readPid(layout.pidFile);
  return pid !== undefined && isAlive(pid) ? "running" : "stopped";
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

  const localHub = detectLocalHub(deps, hub.credentials.url);
  return buildDashboardModel(withRecords, hubEntries, catalogSummary, { today, ...(localHub !== undefined ? { localHub } : {}) });
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
async function gatherSetupFacts(deps: CliDeps, claudePluginOverride?: string): Promise<{ agents: AgentStatus[]; hub: HubPlanFacts; tui: TuiPlanFacts }> {
  const agents = detectAgents(readAgentFacts(deps.homeDir, claudePluginOverride));

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
async function runDoctorCommand(deps: CliDeps, claudePluginOverride?: string): Promise<void> {
  const { agents, hub, tui } = await gatherSetupFacts(deps, claudePluginOverride);
  deps.stdout(formatDoctorLines(agents, hub, tui).join("\n"));
}

/**
 * Gather the plain facts the setup wizard needs (`domain/setup-wizard.ts#createWizardState`):
 * every detected agent, current hub credentials (reused as the "existing
 * hub" step's defaults) and current `tui.json` roots. Entirely read-only,
 * with no network call — the hub's health is checked interactively, from
 * the wizard's own Hub step, never upfront.
 */
export function gatherWizardFacts(deps: CliDeps, claudePluginOverride?: string): WizardFacts {
  const agentFacts = readAgentFacts(deps.homeDir, claudePluginOverride);
  const hubResolution = resolveHub({ env: deps.env ?? {}, homeDir: () => deps.homeDir });
  const credPath = credentialsPath(deps.homeDir);

  const localPort = localHubPort(deps);
  const hub: WizardFacts["hub"] = {
    ...(hubResolution.ok
      ? {
          credentialsPresent: true,
          url: hubResolution.credentials.url,
          email: hubResolution.credentials.email,
          password: hubResolution.credentials.password,
          credentialsPath: credPath,
        }
      : { credentialsPresent: false, url: undefined, email: undefined, password: undefined, credentialsPath: credPath }),
    ...(localPort !== undefined ? { localPort } : {}),
  };

  const tuiPath = tuiConfigPath(deps.homeDir);
  const roots: WizardFacts["roots"] = {
    current: existsSync(tuiPath) ? readTuiConfig(deps.homeDir, deps.cwd).roots : undefined,
    defaultRoots: [dirname(deps.cwd)],
    path: tuiPath,
  };

  return { agentFacts, hub, roots, homeDir: deps.homeDir };
}

/** Builds the injectable dependency bag `adapters/hub-manager/install.ts` needs, sharing one `ScriptRunner`/timer/crypto setup across every real hub-manager call (`kankaku hub *`, the wizard's `install-local-hub` action). */
function buildHubManagerDeps(deps: CliDeps): HubManagerDeps {
  const { now, fetch: fetchOverride } = envDeps(deps);
  return {
    homeDir: deps.homeDir,
    fetch: fetchOverride ?? fetch,
    runner: createChildProcessRunner(),
    startDetached: (binary, args, opts) => startDetached(binary, args, opts),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now,
    randomBytes: (n) => cryptoRandomBytes(n),
    locatePackage: () => locateHubPackage(),
    platform: process.platform,
    arch: process.arch,
    isAlive: (pid) => isAlive(pid),
    portBinder: realPortBinder,
    ...deps.hubManager,
  };
}

/** Runs `adapters/setup/local-hub.ts#installLocalHub` for real: the checkout-based, dev-only local hub install kept behind `kankaku setup --from-checkout <dir>`. */
async function performLocalHubInstallFromCheckout(checkout: string, deps: CliDeps): Promise<{ url: string; serviceEmail: string; servicePassword: string }> {
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
 * what to write) — `state` carries it: `state.hub` for
 * `write-hub`/`install-local-hub`, `state.roots` for `write-roots`.
 * `write-claude` resolves the plugin root itself (`claudePluginOverride`,
 * `--claude-plugin-dir`/`KANKAKU_CLAUDE_PLUGIN_DIR` — see
 * `runCli`/`resolveClaudePluginOverride`), never from wizard state.
 * `install-local-hub` runs the real `hub-manager/install.ts#installHub`
 * (which writes `accounts.json` and `service.json`, and
 * `~/.kankaku/credentials.json` only when none exists or it already
 * points at the local hub), reporting every install step in the result
 * detail - the `sync credentials` step with its own explanation. Never
 * throws: any adapter failure becomes an `"error"` outcome instead.
 */
async function applyWizardAction(action: WizardAction, state: WizardState, deps: CliDeps, claudePluginOverride: string | undefined): Promise<ApplyResult> {
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
        const { root } = locateClaudePlugin(claudePluginOverride);
        const settings = writeClaudeIntegration(action.file, root, readPluginHooks(root));
        const commands = writeClaudeCommands(deps.homeDir, root, readPluginCommands(root));
        const detail = describeCommands(commands);
        return { action, outcome: settings.changed || commands.wrote.length > 0 || commands.removed.length > 0 ? "wrote" : "unchanged", ...(detail ? { detail } : {}) };
      }
      case "remove-claude": {
        const settings = removeClaudeIntegration(action.file);
        const commands = removeClaudeCommands(deps.homeDir);
        const detail = describeCommands(commands);
        return { action, outcome: settings.changed || commands.removed.length > 0 ? "removed" : "unchanged", ...(detail ? { detail } : {}) };
      }
      case "write-hub": {
        const result = writeHubCredentials(deps.homeDir, { url: state.hub.url, email: state.hub.email, password: state.hub.password });
        return { action, outcome: result.changed ? "wrote" : "unchanged" };
      }
      case "install-local-hub": {
        const report = await installHub({ port: parseHubPort(state.hub.port), ownerEmail: state.hub.ownerEmail, ownerPassword: state.hub.ownerPassword }, buildHubManagerDeps(deps));
        const detail = report.steps.map((step) => `${step.step}: ${step.outcome}${step.step === "sync credentials" && step.detail ? ` (${step.detail})` : ""}`).join("; ");
        if (!report.ok) return { action, outcome: "error", detail };
        return { action, outcome: "started", detail: `${detail} — running at ${report.url}` };
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

/** A short wizard-result note about the generated commands: how many were written/removed, and any foreign file left alone. `undefined` when there is nothing to say. */
function describeCommands(result: CommandsWriteResult): string | undefined {
  const parts: string[] = [];
  if (result.wrote.length > 0) parts.push(`${result.wrote.length} command(s) written`);
  if (result.removed.length > 0) parts.push(`${result.removed.length} command(s) removed`);
  if (result.foreign.length > 0) parts.push(`left ${result.foreign.map((file) => basename(file)).join(", ")} alone (not a kankaku command)`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** Tell the user what setup did to the generated commands, one line per file, like {@link announceWrite}. */
function announceCommands(deps: CliDeps, result: CommandsWriteResult): void {
  for (const file of result.wrote) deps.stdout(`wrote ${file}`);
  for (const file of result.unchanged) deps.stdout(`unchanged ${file}`);
  for (const file of result.removed) deps.stdout(`removed ${file}`);
  for (const file of result.foreign) deps.stdout(`skipped ${file} (not a kankaku command)`);
}

/** The binder for the wizard's port probe: the real one, unless a test injected another through `CliDeps.hubManager`. */
function portBinderFor(deps: CliDeps): PortBinder {
  return deps.hubManager?.portBinder ?? realPortBinder;
}

/** Build the setup wizard's `WizardActions` for the interactive app: every write goes through the same real `adapters/setup/*` writers `kankaku setup --yes` uses. Used only by `renderApp`. */
export function buildWizardActions(deps: CliDeps, claudePluginOverride: string | undefined): WizardActions {
  return {
    apply: (action, state) => applyWizardAction(action, state, deps, claudePluginOverride),
    checkHealth: (url) => checkHubHealth(url, { fetch: deps.fetch }),
    isPortFree: (port) => isPortFree(port, portBinderFor(deps)),
    suggestPort: (from) => firstFreePort(from, 20, portBinderFor(deps)),
  };
}

/** `--claude-plugin-dir <dir>`'s value when given, else `KANKAKU_CLAUDE_PLUGIN_DIR`; `undefined` resolves to the bundled `kankaku-claude` package (see `adapters/setup/claude-plugin.ts#locateClaudePlugin`). */
function resolveClaudePluginOverride(args: string[], env: NodeJS.ProcessEnv | undefined): string | undefined {
  return flagValue(args, "--claude-plugin-dir") ?? env?.["KANKAKU_CLAUDE_PLUGIN_DIR"];
}

/** `<value> <unit>`, picking the largest unit that keeps `bytes` at least 1 (`B`/`KB`/`MB`/`GB`), one decimal place past `B`. */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return unitIndex === 0 ? `${value} ${units[unitIndex]}` : `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** Total size in bytes of every regular file under `dir`, recursively; `0` when `dir` does not exist. */
function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : statSync(full).size;
  }
  return total;
}

/** `local hub: running 0.2.0 (PocketBase 0.40.4) at http://127.0.0.1:8090 · pb_data 1.2 MB` / `stopped 0.2.0` / `not installed`. */
function formatHubStatusLine(status: HubStatus, pocketbaseVersion: string | undefined, pbDataBytes: number): string {
  if (status.state === "not-installed") return "local hub: not installed";
  if (status.state === "stopped") return `local hub: stopped${status.version ? ` ${status.version}` : ""}`;
  const label = status.state === "unhealthy" ? "unhealthy" : "running";
  const pbPart = pocketbaseVersion ? ` (PocketBase ${pocketbaseVersion})` : "";
  return `local hub: ${label}${status.version ? ` ${status.version}` : ""}${pbPart} at ${status.url} · pb_data ${formatBytes(pbDataBytes)}`;
}

/** The URL this machine's sync resolves to (`resolveHub`: environment first, then `~/.kankaku/credentials.json`), or `undefined` when none is configured. */
function syncCredentialsUrl(deps: CliDeps): string | undefined {
  const hub = resolveHub({ env: deps.env ?? {}, homeDir: () => deps.homeDir });
  return hub.ok ? hub.credentials.url : undefined;
}

/** The installed local hub's port from `hub.json`, or `undefined` when it is not installed (or `hub.json` is unreadable). */
function localHubPort(deps: CliDeps): number | undefined {
  const layout = hubLayout(deps.homeDir);
  if (!existsSync(layout.hubJson)) return undefined;
  try {
    return parseHubConfig(JSON.parse(readFileSync(layout.hubJson, "utf8"))).port;
  } catch {
    return undefined;
  }
}

/** The installed local hub's URL, or `undefined` when it is not installed. */
function localHubUrl(deps: CliDeps): string | undefined {
  const port = localHubPort(deps);
  return port === undefined ? undefined : `http://127.0.0.1:${port}`;
}

/** `-n <count>`'s value, defaulting to 50 when absent or not a positive integer. */
function logCountFlag(args: string[]): number {
  const index = args.indexOf("-n");
  const value = index === -1 ? undefined : Number(args[index + 1]);
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : 50;
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** `--port`'s value: `undefined` when the flag is absent, `NaN` when it is present but not a whole number between 1 and 65535. */
function portFlag(args: string[]): number | undefined {
  const raw = flagValue(args, "--port");
  if (raw === undefined) return args.includes("--port") ? Number.NaN : undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : Number.NaN;
}

/** Print every `HubActionReport` step, one per line (`<step>: <outcome> (<detail>)`), and the resulting URL when present. */
function printHubReport(deps: CliDeps, report: { steps: { step: string; outcome: string; detail?: string }[]; url?: string }): void {
  for (const step of report.steps) {
    deps.stdout(`${step.step}: ${step.outcome}${step.detail ? ` (${step.detail})` : ""}`);
  }
  if (report.url) deps.stdout(`hub running at ${report.url}`);
}

/**
 * `kankaku hub install|start|stop|status|upgrade|logs`: the local hub's
 * full lifecycle, driven by `adapters/hub-manager/install.ts`. `install`
 * asks for the owner email/password on a TTY (through the injected
 * `Prompter`); without a TTY, `--owner-email`/`--owner-password` are
 * required flags. `status` composes `hubStatus`'s plain `HubStatus` with
 * the installed PocketBase version and the on-disk `pb_data` size, read
 * directly from `hub.json`/the layout — never a second network call.
 */
async function runHubCommand(args: string[], deps: CliDeps): Promise<void> {
  const [sub, ...rest] = args;
  const hubDeps = buildHubManagerDeps(deps);

  if (sub === "install") {
    const port = portFlag(rest);
    if (Number.isNaN(port)) {
      deps.stderr("kankaku hub install: --port must be a whole number between 1 and 65535\n");
      deps.exit(1);
      return;
    }
    let ownerEmail = flagValue(rest, "--owner-email");
    let ownerPassword = flagValue(rest, "--owner-password");
    if ((ownerEmail === undefined || ownerPassword === undefined) && (deps.isTTY?.() ?? false) && deps.prompter) {
      ownerEmail ??= await deps.prompter.text("Owner email", "");
      ownerPassword ??= await deps.prompter.secret("Owner password");
    }
    if (!ownerEmail || !ownerPassword) {
      deps.stderr("kankaku hub install: --owner-email and --owner-password are required (or run on a TTY to be prompted)\n");
      deps.exit(1);
      return;
    }
    const report = await installHub({ port, ownerEmail, ownerPassword }, hubDeps);
    printHubReport(deps, report);
    if (!report.ok) deps.exit(1);
    return;
  }

  if (sub === "start") {
    const report = await startHub(hubDeps);
    printHubReport(deps, report);
    if (!report.ok) deps.exit(1);
    return;
  }

  if (sub === "stop") {
    const report = await stopHub(hubDeps);
    printHubReport(deps, report);
    return;
  }

  if (sub === "status") {
    const status = await hubStatus(hubDeps);
    const layout = hubLayout(deps.homeDir);
    let pocketbaseVersion: string | undefined;
    if (existsSync(layout.hubJson)) {
      try {
        pocketbaseVersion = parseHubConfig(JSON.parse(readFileSync(layout.hubJson, "utf8"))).pocketbaseVersion;
      } catch {
        pocketbaseVersion = undefined;
      }
    }
    deps.stdout(formatHubStatusLine(status, pocketbaseVersion, dirSizeBytes(layout.pbData)));
    deps.stdout(`sync: ${describeSyncTarget(syncCredentialsUrl(deps), localHubUrl(deps))}`);
    return;
  }

  if (sub === "use") {
    const result = useLocalHub(deps.homeDir);
    if (!result.ok) {
      deps.stderr(`kankaku hub use: ${result.error}\n`);
      deps.exit(1);
      return;
    }
    deps.stdout(
      result.changed
        ? `sync now points at ${result.url} (was ${result.previousUrl ?? "not configured"})`
        : `sync credentials: unchanged (already points at ${result.url})`,
    );
    return;
  }

  if (sub === "upgrade") {
    const report = await upgradeHub(hubDeps);
    printHubReport(deps, report);
    if (!report.ok) deps.exit(1);
    return;
  }

  if (sub === "logs") {
    const lines = hubLogs(logCountFlag(rest), hubDeps);
    deps.stdout(lines.length > 0 ? lines.join("\n") : "no logs yet");
    return;
  }

  deps.stderr(USAGE);
  deps.exit(1);
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

/** Tell the user what setup just did to a file: nothing is written silently. */
function announceWrite(deps: CliDeps, file: string, result: { changed: boolean }): void {
  deps.stdout(result.changed ? `wrote ${file}` : `unchanged ${file}`);
}

/** `--from-checkout <dir>`'s value, when present anywhere in `args`. */
function fromCheckoutFlag(args: string[]): string | undefined {
  const index = args.indexOf("--from-checkout");
  return index === -1 ? undefined : args[index + 1];
}

/**
 * `kankaku setup [--yes] [--dry-run] [--from-checkout <dir>] [--claude-plugin-dir <dir>]`:
 * detects every agent, prompts (or takes each question's own default with
 * `--yes`) for what to install or configure, writes only what was
 * confirmed, and ends with the same report as `kankaku doctor`.
 * `--dry-run` prints the plan and writes nothing — no prompt is asked and
 * no default is applied. `--claude-plugin-dir`/`KANKAKU_CLAUDE_PLUGIN_DIR`
 * override the resolved `kankaku-claude` plugin root (see
 * `resolveClaudePluginOverride`); without either, the bundled package is
 * used.
 */
async function runSetupCommand(args: string[], deps: CliDeps): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  const fromCheckout = fromCheckoutFlag(args);
  const claudePluginOverride = resolveClaudePluginOverride(args, deps.env);

  const initial = await gatherSetupFacts(deps, claudePluginOverride);
  const steps = planSetup(initial.agents, initial.hub, initial.tui);

  if (dryRun) {
    const lines = formatSetupPlanLines(steps);
    const claudeStep = steps.find((step) => step.id === "claude-code");
    if (claudeStep && claudeStep.file) {
      try {
        const { root } = locateClaudePlugin(claudePluginOverride);
        lines.push(`Claude plugin root: ${root} (would write ${claudeStep.file})`);
        lines.push(`Claude commands: ${readPluginCommands(root).length} file(s) would be written to ${commandsDirectory(deps.homeDir)}`);
      } catch {
        // The plugin isn't resolvable (e.g. not installed yet); the rest of the plan still prints.
      }
    }
    deps.stdout(lines.join("\n"));
    return;
  }

  const ask = makeAsker(yes, deps.prompter);
  const byId = Object.fromEntries(steps.map((step) => [step.id, step]));

  for (const agent of initial.agents) {
    if (agent.id === "codex" || agent.id === "opencode") continue;
    const step = byId[agent.id]!;
    // A configured Claude Code is still reconciled under --yes: the writers are idempotent, so an up-to-date install only prints `unchanged` lines.
    const reconcileClaude = agent.id === "claude-code" && step.state === "done" && yes;
    if (step.state !== "todo" && !reconcileClaude) continue;

    if (agent.id === "claude-code") {
      const doIt = reconcileClaude || (await ask.confirm(`Configure Claude Code (statusLine + hooks + /kankaku:* commands) for kankaku (${step.file})?`, true));
      if (!doIt) continue;
      try {
        const { root } = locateClaudePlugin(claudePluginOverride);
        const hooks = readPluginHooks(root);
        const commands = readPluginCommands(root);
        announceWrite(deps, step.file, writeClaudeIntegration(step.file, root, hooks));
        announceCommands(deps, writeClaudeCommands(deps.homeDir, root, commands));
      } catch (error) {
        deps.stderr(`kankaku setup: could not configure Claude Code: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      continue;
    }

    const doIt = await ask.confirm(`Install kankaku in ${step.title} (${step.file})?`, true);
    if (doIt) announceWrite(deps, step.file, addKankakuPackage(step.file));
  }

  if (byId["hub"]!.state === "todo" && !initial.hub.credentialsPresent) {
    if (fromCheckout !== undefined) {
      // Hub-developer path (never interactive): install from a local `kankaku-hub` checkout via its own dev scripts, skipping the credential prompts below.
      try {
        const installed = await performLocalHubInstallFromCheckout(fromCheckout, deps);
        writeHubCredentials(deps.homeDir, { url: installed.url, email: installed.serviceEmail, password: installed.servicePassword });
        deps.stdout(`installed a local hub from ${fromCheckout}: running at ${installed.url} (dev defaults: ${installed.serviceEmail} / ${installed.servicePassword})`);
      } catch (error) {
        deps.stderr(`kankaku setup --from-checkout: ${error instanceof Error ? error.message : String(error)}\n`);
        deps.exit(1);
        return;
      }
    } else {
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

  await runDoctorCommand(deps, claudePluginOverride);
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

  if (command === "--version" || command === "-v" || command === "version") {
    deps.stdout(formatVersionLines(readOwnVersion(), readCarriedVersions(deps.resolvePackage)).join("\n"));
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
    const interactiveTTY = !setupArgs.includes("--yes") && !setupArgs.includes("--dry-run") && !setupArgs.includes("--from-checkout") && (deps.isTTY?.() ?? false);
    if (interactiveTTY) {
      deps.renderApp(roots, theme, { startInWizard: true, claudePluginDir: resolveClaudePluginOverride(setupArgs, deps.env) });
      return;
    }
    await runSetupCommand(setupArgs, deps);
    return;
  }

  if (command === "doctor") {
    await runDoctorCommand(deps, resolveClaudePluginOverride(rest.slice(1), deps.env));
    return;
  }

  if (command === "hub") {
    await runHubCommand(rest.slice(1), deps);
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
 * Builds the Dashboard's `localHub` quick action, only when the resolved
 * hub credentials point at this machine's own local hub install (see
 * `detectLocalHub`): `toggle` starts it if stopped, stops it if running,
 * through `hub-manager/install.ts#startHub`/`stopHub`.
 */
function localHubAction(deps: CliDeps, hubUrl: string): DashboardActions["localHub"] {
  const state = detectLocalHub(deps, hubUrl);
  if (state === undefined) return undefined;
  return {
    toggle: async () => {
      const hubDeps = buildHubManagerDeps(deps);
      const report = state === "running" ? await stopHub(hubDeps) : await startHub(hubDeps);
      const verb = state === "running" ? "stopped" : "started";
      return report.ok ? `${verb} the local hub` : `error: ${report.steps.find((step) => step.outcome === "error")?.detail ?? "the local hub action failed"}`;
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
 * function is ever called by the screen. `localHub` is present only when
 * the configured hub is this machine's own local install. Used only by
 * `renderApp`.
 */
export function dashboardActionsDeps(deps: CliDeps, roots: string[]): DashboardActions {
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
    localHub: localHubAction(deps, credentials.url),
  };
}

/**
 * Run the entrypoint only when this file is the script Node was started
 * with. npm installs the binary as a symlink (`node_modules/.bin/kankaku ->
 * ../kankaku/dist/cli.js`), so `process.argv[1]` is the link while
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
            wizard={{
              facts: gatherWizardFacts(realDeps, options?.claudePluginDir ?? process.env["KANKAKU_CLAUDE_PLUGIN_DIR"]),
              actions: buildWizardActions(realDeps, options?.claudePluginDir ?? process.env["KANKAKU_CLAUDE_PLUGIN_DIR"]),
            }}
            startInWizard={options?.startInWizard}
          />
        </ThemeProvider>,
        { alternateScreen: true, exitOnCtrlC: true },
      );
    },
  };
  void runCli(process.argv.slice(2), realDeps);
}
