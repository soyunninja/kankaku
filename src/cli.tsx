#!/usr/bin/env node
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
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

export interface CliDeps {
  homeDir: string;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
  renderApp: (roots: string[], theme: Theme) => void;
  /** Injectable for tests; defaults to `process.env` at the real entry point. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to `Date.now` at the real entry point. */
  now?: () => number;
  /** Injectable for tests; defaults to `os.hostname` at the real entry point. */
  hostname?: () => string;
  /** Injectable for tests; defaults to the global `fetch` at the real entry point. */
  fetch?: typeof fetch;
}

const USAGE =
  "usage: kankaku [today|tasks [--all]|catalog [refresh]|sync [status|all] [--project <dir>]] [--roots a,b] [--theme name]\n";

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
    deps.renderApp(roots, theme);
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
    renderApp: (roots, theme) => {
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
          />
        </ThemeProvider>,
        { alternateScreen: true, exitOnCtrlC: true },
      );
    },
  };
  void runCli(process.argv.slice(2), realDeps);
}
