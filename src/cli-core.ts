import { basename, join } from "node:path";
import { JsonlWorkLog } from "kankaku/hub";
import { listStateFiles, resolveKankakuDir } from "./paths.ts";
import { readState } from "./session-state.ts";
import { readCost } from "./cost-store.ts";
import { formatReport } from "./report.ts";

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => number;
  isAlive: (pid: number) => boolean;
  /** Absolute path to the plugin/repo root (the directory containing `.claude-plugin/`). */
  pluginRoot: string;
}

export interface CliResult {
  stdout: string;
  exitCode: number;
  /** Set only for the usage message on an unknown command. */
  stderr?: string;
}

const USAGE = "usage: node src/cli.ts <report|status|setup> [--days N]\n";

/** `node src/cli.ts <report|status|setup> [--days N]`, resolved from `deps.cwd`. */
export function runCli(argv: string[], deps: CliDeps): CliResult {
  const [command, ...rest] = argv;
  switch (command) {
    case "report":
      return runReport(rest, deps);
    case "status":
      return runStatus(deps);
    case "setup":
      return runSetup(deps);
    default:
      return { stdout: "", exitCode: 1, stderr: USAGE };
  }
}

function runReport(args: string[], deps: CliDeps): CliResult {
  const days = parseDays(args);
  const kankakuDir = resolveKankakuDir(deps.env.KANKAKU_DIR ?? ".kankaku", deps.cwd);
  const records = new JsonlWorkLog(kankakuDir).readAll();
  const stdout = formatReport(records, { now: deps.now(), ...(days !== undefined ? { days } : {}) });
  return { stdout, exitCode: 0 };
}

function parseDays(args: string[]): number | undefined {
  const idx = args.indexOf("--days");
  if (idx === -1) return undefined;
  const value = Number(args[idx + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function runStatus(deps: CliDeps): CliResult {
  const kankakuDir = resolveKankakuDir(deps.env.KANKAKU_DIR ?? ".kankaku", deps.cwd);
  const claudeDir = join(kankakuDir, "claude");
  const files = listStateFiles(claudeDir);
  if (files.length === 0) {
    return { stdout: "No active sessions.\n", exitCode: 0 };
  }
  const lines = files
    .sort()
    .map((file) => formatStatusLine(sessionIdFromStateFile(file), file, deps.isAlive, deps.env));
  return { stdout: lines.join("\n") + "\n", exitCode: 0 };
}

function formatStatusLine(
  sessionId: string,
  stateFile: string,
  isAlive: (pid: number) => boolean,
  env: NodeJS.ProcessEnv,
): string {
  const state = readState(stateFile);
  if (!state) return `${sessionId}  (unreadable state)`;
  const aliveWord = isAlive(state.pid) ? "alive" : "dead";
  const promptWord = state.promptOpen
    ? `prompt open since ${new Date(state.promptOpen.startedAt).toISOString()}`
    : "idle";
  const cost = readCost(env, sessionId);
  const costWord = cost ? `$${cost.totalUsd.toFixed(2)}` : "-";
  return `${sessionId}  pid ${state.pid} (${aliveWord})  ${promptWord}  cost ${costWord}`;
}

function sessionIdFromStateFile(file: string): string {
  return basename(file).replace(/\.state\.json$/, "");
}

function runSetup(deps: CliDeps): CliResult {
  const statuslinePath = join(deps.pluginRoot, "src", "statusline.ts");
  const command = `node "${statuslinePath}"`;
  const snippet = JSON.stringify({ statusLine: { type: "command", command } }, null, 2);
  const explanation =
    "Claude Code plugins cannot set statusLine themselves, so this must be added to ~/.claude/settings.json manually: the statusline is the only documented source of per-session cost.";
  return { stdout: `${snippet}\n\n${explanation}\n`, exitCode: 0 };
}
