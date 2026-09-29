import { homedir } from "node:os";
import { join } from "node:path";
import { CachedCatalog, PocketBaseClient, createPocketBaseCatalogFetcher, resolveHubCredentials } from "kankaku-pi/hub";
import type { HubTask } from "kankaku-pi/domain";
import type { CliDeps, CliResult } from "./cli-core.ts";
import { findSession } from "./find-session.ts";
import { resolveKankakuDir, resolveTargetFile } from "./paths.ts";
import { readSessionTarget, writeSessionTarget } from "./session-target-store.ts";
import { listOpenTasks, selectTask } from "./task-select.ts";
import { resolveClaudeWorkTarget } from "./work-target.ts";

const DEFAULT_REFRESH_MS = 3000;
const NO_SESSION = "no active Claude Code session found for this folder\n";
const HINT = "pick one with: /kankaku:task <number>";

const say = (lines: string[], exitCode: number): CliResult => ({ stdout: lines.join("\n") + "\n", exitCode });

/**
 * `task [list | clear | <number> | <hub id> | <text>]`: links the hub task
 * this Claude Code session is working on, session-only (see
 * `session-target-store.ts`). Not a hook: it may use the network, bounded.
 */
export async function runTaskCli(args: string[], deps: CliDeps): Promise<CliResult> {
  const kankakuDir = resolveKankakuDir(deps.env.KANKAKU_DIR ?? ".kankaku", deps.cwd);
  const claudeDir = join(kankakuDir, "claude");
  const session = findSession({
    claudeDir,
    env: deps.env,
    ...(deps.pid !== undefined ? { pid: deps.pid } : {}),
    ...(deps.runPs !== undefined ? { runPs: deps.runPs } : {}),
  });
  if (!session) return { stdout: NO_SESSION, exitCode: 1 };
  const file = resolveTargetFile(claudeDir, session);
  const stored = readSessionTarget(file) ?? { lastList: [] };

  const arg = args.join(" ").trim();
  if (arg === "clear") {
    if (stored.hubTaskId === undefined) return say(["no task linked"], 0);
    writeSessionTarget(file, { lastList: stored.lastList });
    return say(["task link cleared"], 0);
  }

  const homeDir = deps.env.HOME || homedir();
  const note = await refreshCatalog(deps, homeDir);
  const prefix = note?.text ? [note.text] : [];
  const resolved = resolveClaudeWorkTarget({ cwd: deps.cwd, kankakuDir, homeDir, env: deps.env });
  const projectId = resolved.target?.projectId;
  if (!resolved.target || projectId === undefined) {
    const reason = resolved.reason ?? "the resolved client has no project";
    return say([...prefix, `no project resolved for this folder (${reason}); a task belongs to a project`], 1);
  }
  const projectName = resolved.target.projectName ?? projectId;
  const open = listOpenTasks(note?.tasks ?? [], projectId);

  if (arg === "" || arg === "list") {
    if (open.length === 0) return say([...prefix, `no open tasks in project ${projectName}`], 0);
    writeSessionTarget(file, { ...stored, lastList: open.map((task) => task.id) });
    return say([...prefix, `open tasks in project ${projectName}:`, ...numbered(open, stored.hubTaskId), HINT], 0);
  }

  const selection = selectTask(arg, { open, lastList: stored.lastList });
  if (selection.kind === "unknown") return say([...prefix, selection.message], 1);
  if (selection.kind === "ambiguous") {
    writeSessionTarget(file, { ...stored, lastList: selection.candidates.map((task) => task.id) });
    return say([...prefix, `several open tasks match "${arg}":`, ...numbered(selection.candidates, stored.hubTaskId), HINT], 1);
  }
  const task = selection.task;
  writeSessionTarget(file, {
    hubTaskId: task.id, hubTaskTitle: task.title, projectId, pickedAt: deps.now(), lastList: stored.lastList,
  });
  return say([...prefix, `linked: ${task.title}`], 0);
}

function numbered(tasks: HubTask[], linkedId: string | undefined): string[] {
  return tasks.map((task, index) => {
    const ref = task.externalRef ? ` (${task.externalRef})` : "";
    const linked = task.id === linkedId;
    return `${linked ? "*" : " "} ${index + 1}. ${task.title}${ref}${linked ? " [linked]" : ""}`;
  });
}

interface CatalogRead {
  tasks: HubTask[];
  /** Set when the refresh failed and the cache was used instead. */
  text?: string;
}

/**
 * Best-effort refresh bounded by `catalogTimeoutMs`; on failure the cached
 * snapshot is used and its age reported. `undefined` when there is neither
 * credentials nor a cache (the project lookup then reports why).
 */
async function refreshCatalog(deps: CliDeps, homeDir: string): Promise<CatalogRead | undefined> {
  const hub = resolveHubCredentials({ env: deps.env, homeDir: () => homeDir });
  if (!hub.credentials) return undefined;
  const client = new PocketBaseClient({ ...hub.credentials, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const catalog = new CachedCatalog({
    filePath: join(homeDir, ".kankaku", "catalog.json"),
    url: hub.credentials.url,
    clock: { now: deps.now },
    fetchCatalog: createPocketBaseCatalogFetcher(client),
  });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(undefined); }, deps.catalogTimeoutMs ?? DEFAULT_REFRESH_MS);
  });
  const fresh = await Promise.race([catalog.refresh(controller.signal), timeout]);
  clearTimeout(timer);
  if (fresh) return { tasks: fresh.tasks ?? [] };
  const cached = catalog.read();
  if (!cached) return undefined;
  return { tasks: cached.tasks ?? [], text: `catalog from cache, ${formatAge(deps.now() - cached.fetchedAt)} old` };
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
