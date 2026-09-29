import { basename, join } from "node:path";
import { JsonlWorkLog } from "kankaku-pi/hub";
import { listStateFiles, resolveKankakuDir } from "./paths.ts";
import { readState } from "./session-state.ts";
import { readCost } from "./cost-store.ts";
import { formatReport } from "./report.ts";
import { runSyncCli } from "./sync-cli.ts";
import { runDoctor } from "./doctor.ts";
import { runTaskCli } from "./task-cli.ts";
import type { PsInfo } from "./claude-pid.ts";
import { formatTargetLine, formatTaskLine, resolveSessionWorkTarget } from "./work-target.ts";

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => number;
  isAlive: (pid: number) => boolean;
  /** Absolute path to the plugin/repo root (the directory containing `.claude-plugin/`). */
  pluginRoot: string;
  /** The CLI's own pid, to find the Claude Code session it runs under. Without it only `KANKAKU_CLAUDE_SESSION` finds one. */
  pid?: number;
  runPs?: (pid: number) => PsInfo | undefined;
  /** Injected in tests; defaults to `globalThis.fetch`. Used by `task` to refresh the catalog. */
  fetch?: typeof fetch;
  /** Upper bound for the best-effort catalog refresh done by `task`. Defaults to 3000. */
  catalogTimeoutMs?: number;
}

export interface CliResult {
  stdout: string;
  exitCode: number;
  /** Usage or sync error output. */
  stderr?: string;
}

const USAGE = "usage: node dist/cli.js <report|status|setup|sync|doctor|task> [--days N]\n";

/** CLI commands, resolved from `deps.cwd`. */
export async function runCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  const [command, ...rest] = argv;
  switch (command) {
    case "report":
      return runReport(rest, deps);
    case "status":
      return runStatus(deps);
    case "setup":
      return runSetup(deps);
    case "sync":
      return runSyncCli(rest, deps);
    case "task":
      return runTaskCli(rest, deps);
    case "doctor":
      return { stdout: runDoctor(deps), exitCode: 0 };
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
  const resolved = resolveSessionWorkTarget(deps);
  const targetLine = `${formatTargetLine(resolved)}\n${formatTaskLine(resolved)}`;
  if (files.length === 0) {
    return { stdout: `${targetLine}\nNo active sessions.\n`, exitCode: 0 };
  }
  const recordedBySession = new Map<string, number>();
  for (const record of new JsonlWorkLog(kankakuDir).readAll()) {
    if (record.sessionId === undefined) continue;
    recordedBySession.set(record.sessionId, (recordedBySession.get(record.sessionId) ?? 0) + record.usage.cost);
  }
  const lines = files
    .sort()
    .map((file) => {
      const sessionId = sessionIdFromStateFile(file);
      return formatStatusLine(sessionId, file, deps.isAlive, deps.env, recordedBySession.get(sessionId) ?? 0);
    });
  return { stdout: [targetLine, ...lines].join("\n") + "\n", exitCode: 0 };
}

function formatStatusLine(
  sessionId: string,
  stateFile: string,
  isAlive: (pid: number) => boolean,
  env: NodeJS.ProcessEnv,
  recordedUsd: number,
): string {
  const state = readState(stateFile);
  if (!state) return `${sessionId}  (unreadable state)`;
  const aliveWord = isAlive(state.pid) ? "alive" : "dead";
  const promptWord = state.promptOpen
    ? `prompt open since ${new Date(state.promptOpen.startedAt).toISOString()}`
    : "idle";
  const cost = readCost(env, sessionId);
  const costWord = cost ? `$${cost.totalUsd.toFixed(2)}` : "-";
  const base = `${sessionId}  pid ${state.pid} (${aliveWord})  ${promptWord}  cost ${costWord}`;
  if (!cost) return base;
  const gap = cost.totalUsd - recordedUsd;
  const warning = gap > 0.01 && !state.promptOpen ? ` (unrecorded $${gap.toFixed(2)}, goes to the next prompt)` : "";
  return `${base}  recorded $${recordedUsd.toFixed(2)} of $${cost.totalUsd.toFixed(2)}${warning}`;
}

function sessionIdFromStateFile(file: string): string {
  return basename(file).replace(/\.state\.json$/, "");
}

function runSetup(deps: CliDeps): CliResult {
  const statuslinePath = join(deps.pluginRoot, "dist", "statusline.js");
  const command = `node "${statuslinePath}"`;
  const snippet = JSON.stringify({ statusLine: { type: "command", command } }, null, 2);
  const explanation =
    "Claude Code plugins cannot set statusLine themselves, so this must be added to ~/.claude/settings.json manually: the statusline is the only documented source of per-session cost.";
  return { stdout: `${snippet}\n\n${explanation}\n`, exitCode: 0 };
}
