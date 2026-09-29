import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JsonlWorkLog, SyncStateStore, computeSyncStatus, resolveHubCredentials } from "kankaku-pi/hub";
import type { CliDeps } from "./cli-core.ts";
import { costDir } from "./cost-store.ts";
import { listStateFiles, resolveKankakuDir } from "./paths.ts";
import { readState } from "./session-state.ts";
import { formatTargetLine, formatTaskLine, resolveSessionWorkTarget } from "./work-target.ts";

function metadata(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function label(value: unknown): string {
  // Metadata is local but not trusted: never echo arbitrary object or secret-looking fields.
  return typeof value === "string" && /^[\w.-]+$/.test(value) ? value : "unavailable";
}

function syncWindowHours(env: NodeJS.ProcessEnv): number {
  const hours = Number(env.KANKAKU_SYNC_WINDOW_HOURS);
  return env.KANKAKU_SYNC_WINDOW_HOURS && Number.isFinite(hours) && hours > 0 ? hours : 24;
}

function workTargetLines(deps: CliDeps): string[] {
  const resolved = resolveSessionWorkTarget(deps);
  return [formatTargetLine(resolved), formatTaskLine(resolved)];
}

/** Read-only, local diagnostic. No sync runner or network client is reachable from this path. */
export function runDoctor(deps: CliDeps): string {
  const dir = resolveKankakuDir(deps.env.KANKAKU_DIR ?? ".kankaku", deps.cwd);
  const pkg = metadata(join(deps.pluginRoot, "package.json"));
  const plugin = metadata(join(deps.pluginRoot, ".claude-plugin", "plugin.json"));
  const worklogPath = join(dir, "worklog.jsonl");
  const log = new JsonlWorkLog(dir);
  let recordCount: string;
  try { recordCount = String(log.readAll().length); } catch { recordCount = "unreadable"; }
  const states = listStateFiles(join(dir, "claude"));
  let alive = 0;
  let dead = 0;
  let open = 0;
  let unreadable = 0;
  for (const file of states) {
    const state = readState(file);
    if (!state) { unreadable++; continue; }
    if (state.pid > 0 && Number.isInteger(state.pid) && deps.isAlive(state.pid)) alive++;
    else dead++;
    if (state.promptOpen) open++;
  }
  let costsVisible = false;
  try { costsVisible = readdirSync(costDir(deps.env)).some((file) => file.endsWith(".json")); } catch { /* missing or inaccessible */ }

  const hub = resolveHubCredentials({ env: deps.env, homeDir: () => deps.env.HOME || homedir() });
  const store = new SyncStateStore({ dir, pid: process.pid, now: deps.now });
  const target = hub.credentials?.url ?? store.read()?.target ?? "";
  const { state, pending, staleOutsideWindow } = computeSyncStatus(log, store, target, syncWindowHours(deps.env));
  const hubState = hub.invalidReason ? "invalid URL" : hub.credentials ? "configured" : "unconfigured";
  const commands = ["report", "status", "setup", "sync", "sync-status", "sync-all", "doctor", "task"];
  const present = commands.filter((name) => existsSync(join(deps.pluginRoot, "commands", `${name}.md`))).length;
  const actions = ["/kankaku:status", "/kankaku:sync-status"];
  if (!costsVisible) actions.unshift("/kankaku:setup (configure the statusline for cost)");
  if (hubState === "invalid URL") actions.push("Check KANKAKU_PB_URL (HTTPS required)");
  else if (hubState === "unconfigured") actions.push("Configure hub credentials to enable sync");

  return [
    "# kankaku doctor", "", "## Package / plugin",
    `package version: ${label(pkg?.version)}`,
    `plugin name: ${label(plugin?.name)}`,
    `plugin version: ${label(plugin?.version)}`,
    `pluginRoot: ${deps.pluginRoot}`,
    "", "## Local files",
    `KANKAKU_DIR: ${dir}`,
    `worklog: ${existsSync(worklogPath) ? "present" : "absent"} (${recordCount} records)`,
    `command files present: ${present}/${commands.length}`,
    `hooks file present: ${existsSync(join(deps.pluginRoot, "hooks", "hooks.json")) ? "yes" : "no"}`,
    "", "## Sessions / cost",
    `active sessions: ${states.length}`,
    `alive: ${alive}; dead: ${dead}; open prompts: ${open}; unreadable: ${unreadable}`,
    `cost files visible: ${costsVisible ? "yes" : "no"} (current HOME)`,
    "", "## Work target",
    ...workTargetLines(deps),
    "", "## Hub / sync",
    `hub: ${hubState}`,
    `pending: ${pending}`,
    `staleOutsideWindow: ${staleOutsideWindow}`,
    `syncedThrough: ${typeof state?.syncedThrough === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(state.syncedThrough) ? state.syncedThrough : "none"}`,
    // Stored error messages can contain server responses or credentials; only show presence.
    `last sync error: ${state?.lastError ? "present" : "none"}`,
    "", "## Next actions", ...actions.map((action) => `- ${action}`), "",
  ].join("\n");
}
