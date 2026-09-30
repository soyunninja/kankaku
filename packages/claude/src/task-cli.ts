import { homedir } from "node:os";
import { join } from "node:path";
import type { HubTask } from "kankaku-pi/domain";
import type { CliDeps, CliResult } from "./cli-core.ts";
import { refreshCatalog } from "./catalog-refresh.ts";
import { findSession } from "./find-session.ts";
import { resolveKankakuDir, resolveTargetFile } from "./paths.ts";
import { readSessionTarget, withoutTaskLink, writeSessionTarget } from "./session-target-store.ts";
import { listOpenTasks, selectTask } from "./task-select.ts";
import { resolveClaudeWorkTarget } from "./work-target.ts";

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
  const stored = readSessionTarget(file) ?? { lastList: { kind: "tasks", ids: [] } };

  const arg = args.join(" ").trim();
  if (arg === "clear") {
    if (stored.hubTaskId === undefined) return say(["no task linked"], 0);
    writeSessionTarget(file, withoutTaskLink(stored));
    return say(["task link cleared"], 0);
  }

  const homeDir = deps.env.HOME || homedir();
  const note = await refreshCatalog(deps, homeDir);
  const prefix = note?.text ? [note.text] : [];
  const tasks = note?.snapshot.tasks ?? [];
  const shownIds = stored.lastList.kind === "tasks" ? stored.lastList.ids : [];
  const resolved = resolveClaudeWorkTarget({ cwd: deps.cwd, kankakuDir, homeDir, env: deps.env });
  const projectId = resolved.target?.projectId;
  if (!resolved.target || projectId === undefined) {
    const reason = resolved.reason ?? "the resolved client has no project";
    return say([...prefix, `no project resolved for this folder (${reason}); a task belongs to a project`], 1);
  }
  const projectName = resolved.target.projectName ?? projectId;
  const open = listOpenTasks(tasks, projectId);

  if (arg === "" || arg === "list") {
    if (open.length === 0) return say([...prefix, `no open tasks in project ${projectName}`], 0);
    writeSessionTarget(file, { ...stored, lastList: { kind: "tasks", ids: open.map((task) => task.id) } });
    return say([...prefix, `open tasks in project ${projectName}:`, ...numbered(open, stored.hubTaskId), HINT], 0);
  }

  const selection = selectTask(arg, { open, lastList: shownIds });
  if (selection.kind === "unknown") return say([...prefix, selection.message], 1);
  if (selection.kind === "ambiguous") {
    writeSessionTarget(file, { ...stored, lastList: { kind: "tasks", ids: selection.candidates.map((task) => task.id) } });
    return say([...prefix, `several open tasks match "${arg}":`, ...numbered(selection.candidates, stored.hubTaskId), HINT], 1);
  }
  const task = selection.task;
  writeSessionTarget(file, {
    ...stored, hubTaskId: task.id, hubTaskTitle: task.title, projectId, pickedAt: deps.now(),
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
