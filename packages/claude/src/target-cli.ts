import { homedir } from "node:os";
import { join } from "node:path";
import type { Client, HubTask, Project } from "kankaku-pi/domain";
import type { CliDeps, CliResult } from "./cli-core.ts";
import { refreshCatalog } from "./catalog-refresh.ts";
import { findSession } from "./find-session.ts";
import { resolveKankakuDir, resolveTargetFile } from "./paths.ts";
import { readSessionTarget, sessionInputs, withoutTaskLink, writeSessionTarget } from "./session-target-store.ts";
import type { SessionList, SessionTargetLink } from "./session-target-store.ts";
import { activeClients, activeProjects, pickBoth, pickTarget, taskLinkOutcome } from "./target-select.ts";
import type { BothPick, SelectionContext } from "./target-select.ts";
import { formatTargetLine, resolveClaudeWorkTarget } from "./work-target.ts";
import type { ClaudeWorkTarget } from "./work-target.ts";

const NO_SESSION = "no active Claude Code session found for this folder\n";
const NO_CATALOG = "no catalog: configure the hub or run kankaku catalog refresh";
const HINT = "pick one with: /kankaku:target <number>";
const EMPTY_LIST: SessionList = { kind: "tasks", ids: [] };

const say = (lines: string[], exitCode: number): CliResult => ({ stdout: lines.join("\n") + "\n", exitCode });

/**
 * `target [<number | code | text> [<project>] | clear]`: picks the client
 * and project this Claude Code session works for, session-only (see
 * `session-target-store.ts`); it never touches the project's `config.json`.
 * Not a hook: it may use the network, bounded, like `task`.
 */
export async function runTargetCli(args: string[], deps: CliDeps): Promise<CliResult> {
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
  const stored: SessionTargetLink = readSessionTarget(file) ?? { lastList: EMPTY_LIST };
  const words = args.map((word) => word.trim()).filter((word) => word !== "");

  const homeDir = deps.env.HOME || homedir();
  const catalog = await refreshCatalog(deps, homeDir);
  const prefix = catalog?.text ? [catalog.text] : [];
  const resolve = (sessionTarget?: { clientId: string; projectId?: string }): ClaudeWorkTarget =>
    resolveClaudeWorkTarget({ cwd: deps.cwd, kankakuDir, homeDir, env: deps.env, ...(sessionTarget ? { sessionTarget } : {}) });

  if (words.length === 1 && words[0]!.toLowerCase() === "clear") {
    return clear({ file, stored, prefix, tasks: catalog?.snapshot.tasks ?? [], automatic: resolve() });
  }
  if (!catalog) return say([NO_CATALOG], 1);

  const { clients, projects, tasks = [] } = catalog.snapshot;
  const link = sessionInputs(stored).taskLink;
  const ctx: SelectionContext = {
    clients, projects, lastList: stored.lastList, ...(stored.clientId !== undefined ? { clientId: stored.clientId } : {}),
  };

  if (words.length === 0) {
    const shown = activeClients(clients);
    writeSessionTarget(file, { ...stored, lastList: { kind: "clients", ids: shown.map((client) => client.id) } });
    const current = formatTargetLine(resolve(sessionInputs(stored).sessionTarget));
    return say([...prefix, current, ...(shown.length > 0 ? [...clientLines(shown), HINT] : ["no active clients"])], 0);
  }

  const pick = choose(words, ctx);
  if (pick.kind === "unknown") return say([...prefix, pick.message], 1);
  if (pick.kind === "ambiguous") {
    const isClients = pick.of === "clients";
    writeSessionTarget(file, { ...stored, lastList: { kind: pick.of, ids: pick.candidates.map((entry) => entry.id) } });
    const shown = isClients ? clientLines(pick.candidates as Client[]) : projectLines(pick.candidates as Project[]);
    const owner = clients.find((client) => client.id === stored.clientId);
    const what = isClients || owner === undefined ? pick.of : `${pick.of} of ${owner.name}`;
    return say([...prefix, `several ${what} match "${words.join(" ")}":`, ...shown, HINT], 1);
  }

  const now = deps.now();
  if (pick.kind === "client") {
    const outcome = taskLinkOutcome(link, tasks, undefined);
    const shown = activeProjects(projects, pick.client.id);
    const { projectId: _project, ...rest } = stored.hubTaskId !== undefined ? withoutTaskLink(stored) : stored;
    writeSessionTarget(file, {
      ...rest, clientId: pick.client.id, pickedTargetAt: now, lastList: { kind: "projects", ids: shown.map((project) => project.id) },
    });
    return say([
      ...prefix, `client set to ${pick.client.name}`, ...(outcome ? [outcome.message] : []),
      ...(shown.length > 0 ? [...projectLines(shown), HINT] : ["no active projects"]),
    ], 0);
  }

  const client = pick.kind === "both" ? pick.client : clients.find((entry) => entry.id === stored.clientId)!;
  const outcome = taskLinkOutcome(link, tasks, pick.project);
  const base = outcome?.keep === false ? withoutTaskLink(stored) : stored;
  writeSessionTarget(file, {
    ...base, clientId: client.id, projectId: pick.project.id, pickedTargetAt: now,
    lastList: pick.kind === "both" ? EMPTY_LIST : stored.lastList,
  });
  return say([...prefix, `target set to ${client.name} · ${pick.project.name}`, ...(outcome ? [outcome.message] : [])], 0);
}

/**
 * One word is `pickTarget`'s. Several words are `<client> <project>` (see
 * `pickBoth`); when that finds nothing they may still be one multi-word name
 * ("Acme Corp"), which is then tried as a whole.
 */
function choose(words: string[], ctx: SelectionContext): BothPick {
  if (words.length === 1) return pickTarget(words[0]!, ctx);
  const both = pickBoth(words, ctx);
  if (both.kind !== "unknown") return both;
  const whole = pickTarget(words.join(" "), ctx);
  return whole.kind === "client" || whole.kind === "project" ? whole : both;
}

interface ClearInput {
  file: string;
  stored: SessionTargetLink;
  prefix: string[];
  tasks: HubTask[];
  /** What the resolution gives once the session target is gone. */
  automatic: ClaudeWorkTarget;
}

function clear({ file, stored, prefix, tasks, automatic }: ClearInput): CliResult {
  if (stored.clientId === undefined) return say([...prefix, "no session target to clear"], 0);
  const project = automatic.target?.projectId !== undefined
    ? { id: automatic.target.projectId, name: automatic.target.projectName ?? automatic.target.projectId }
    : undefined;
  const outcome = taskLinkOutcome(sessionInputs(stored).taskLink, tasks, project);
  const { clientId: _client, pickedTargetAt: _at, projectId: _project, ...rest } = stored;
  const kept: SessionTargetLink = outcome?.keep === true && project !== undefined ? { ...rest, projectId: project.id } : withoutTaskLink(rest);
  writeSessionTarget(file, { ...kept, lastList: EMPTY_LIST });
  const back = automatic.target !== undefined ? formatTargetLine(automatic).replace(/^target: /, "") : `none (${automatic.reason ?? "unresolved"})`;
  return say([...prefix, `target cleared for this session; back to ${back}`, ...(outcome ? [outcome.message] : [])], 0);
}

function clientLines(clients: Client[]): string[] {
  return clients.map((client, index) => `  ${index + 1}. ${client.name} (${client.code})`);
}

function projectLines(projects: Project[]): string[] {
  return projects.map((project, index) => `  ${index + 1}. ${project.name}${project.code ? ` (${project.code})` : ""}`);
}
