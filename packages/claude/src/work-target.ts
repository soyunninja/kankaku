import { homedir } from "node:os";
import { join } from "node:path";
import {
  CachedCatalog, readProjectClient, readProjectTargetIds, resolveHubCredentials,
} from "kankaku-pi/hub";
import {
  formatWorkTargetLabel, isValidClient, resolveClient, resolveWorkTarget, resolveWorkTargetSource,
} from "kankaku-pi/domain";
import type { WorkTarget } from "kankaku-pi/domain";
import type { PsInfo } from "./claude-pid.ts";
import { findSession } from "./find-session.ts";
import { resolveKankakuDir, resolveTargetFile } from "./paths.ts";
import { readSessionTarget, sessionInputs } from "./session-target-store.ts";

export interface ClaudeWorkTargetInput {
  /** The session's working directory, matched against the catalog's `repo_paths`. */
  cwd: string;
  /** The project's kankaku dir (holds `config.json`). */
  kankakuDir: string;
  /** Home directory holding `.kankaku/catalog.json` and `.kankaku/credentials.json`. */
  homeDir: string;
  env: NodeJS.ProcessEnv;
  /**
   * The client (and project) this session picked with `/kankaku:target`. It
   * goes to the library as the session candidate: it wins over the project
   * config and `repo_paths` while it resolves to an active catalog entry,
   * and falls through otherwise.
   */
  sessionTarget?: { clientId: string; projectId?: string };
  /**
   * The hub task this session linked with `/kankaku:task`. Validated
   * against the resolved project by the library's `resolveWorkTarget` (as
   * the session source's task): kept when it belongs to that project,
   * otherwise dropped and reported in {@link ClaudeWorkTarget.droppedTask}.
   */
  taskLink?: { hubTaskId: string; hubTaskTitle?: string };
}

/** What a record needs stamped: the hub target and the legacy `client` label. */
export interface RecordAssignment {
  target?: WorkTarget;
  /** Legacy free-text `client` label; omitted when none resolves or the code is invalid. */
  legacyClient?: string;
}

export interface ClaudeWorkTarget extends RecordAssignment {
  source?: "session" | "project" | "repoPaths";
  /** Why there is no target; set only when {@link ClaudeWorkTarget.target} is absent. */
  reason?: string;
  /** Set when a `taskLink` was given but could not be applied; `title` is what the user linked. */
  droppedTask?: { title: string };
}

/**
 * Resolves the work target for a session, for record stamping and display.
 *
 * Sources, in order: the session's `/kankaku:target` pick, the project's
 * `config.json` ids, then the cached
 * catalog's `repo_paths` match for `cwd`. The catalog comes only from the
 * cache file that every real sync refreshes — there is no fetch, no refresh
 * and no network here, and nothing throws: an unusable cache means "no
 * target". The precedence and eligibility rules (active, not the
 * "unassigned" client, project belongs to the client) live entirely in the
 * library's `resolveWorkTarget`.
 *
 * Only the heavy hooks (Stop, SessionEnd, recovery) and the CLI call this;
 * the per-tool-call hooks never do.
 */
export function resolveClaudeWorkTarget(input: ClaudeWorkTargetInput): ClaudeWorkTarget {
  try {
    return resolveUnsafe(input);
  } catch {
    return { reason: "no catalog cache" };
  }
}

function resolveUnsafe(input: ClaudeWorkTargetInput): ClaudeWorkTarget {
  const projectClient = readProjectClient(input.kankakuDir);
  const legacyFallback = resolveClient({ env: input.env.KANKAKU_CLIENT, project: projectClient });
  const link = input.taskLink;
  const dropped = link !== undefined ? { droppedTask: { title: link.hubTaskTitle ?? link.hubTaskId } } : {};
  const withLegacy = (result: ClaudeWorkTarget): ClaudeWorkTarget => {
    const base = result.target === undefined ? { ...result, ...dropped } : result;
    return legacyFallback !== undefined ? { ...base, legacyClient: legacyFallback } : base;
  };

  const snapshot = readCatalogCache(input);
  if (!snapshot) return withLegacy({ reason: "no catalog cache" });

  const resolveInput = {
    ...(input.sessionTarget !== undefined ? { session: input.sessionTarget } : {}),
    project: readProjectTargetIds(input.kankakuDir),
    cwd: input.cwd,
    clients: snapshot.clients,
    projects: snapshot.projects,
  };
  const target = resolveWorkTarget(resolveInput);
  const source = resolveWorkTargetSource(resolveInput);
  if (!target || source === undefined) {
    return withLegacy({ reason: `no match for ${input.cwd}` });
  }
  // Mirrors the pi extension: with a hub target the legacy label is the
  // client's code, omitted when it is not a valid label.
  // A linked task is validated by the library as the session source's task:
  // same client and project as resolved above, so it can only ever add the
  // task (kept when it belongs to that project and is still in the catalog).
  const withTask =
    link !== undefined && target.projectId !== undefined
      ? resolveWorkTarget({
          ...resolveInput,
          session: { clientId: target.clientId, projectId: target.projectId, hubTaskId: link.hubTaskId },
          tasks: snapshot.tasks ?? [],
        })
      : undefined;
  const finalTarget = withTask?.hubTaskId !== undefined ? withTask : target;
  return {
    target: finalTarget,
    source,
    ...(link !== undefined && finalTarget.hubTaskId === undefined ? dropped : {}),
    ...(isValidClient(target.clientCode) ? { legacyClient: target.clientCode } : {}),
  };
}

function readCatalogCache(input: ClaudeWorkTargetInput) {
  // The cache is keyed by hub url; the url comes from credentials (env or
  // file), which are read locally. No credentials, no way to trust a cache.
  const hub = resolveHubCredentials({ env: input.env, homeDir: () => input.homeDir });
  if (!hub.credentials) return undefined;
  return new CachedCatalog({
    filePath: join(input.homeDir, ".kankaku", "catalog.json"),
    url: hub.credentials.url,
    clock: { now: () => 0 }, // read() never consults the clock
    fetchCatalog: () => Promise.reject(new Error("the hook path never fetches")),
  }).read();
}

/** The `target:` line printed by `/kankaku:status` and `/kankaku:doctor`. */
export function formatTargetLine(result: ClaudeWorkTarget): string {
  if (!result.target) return `target: none (${result.reason ?? "unresolved"})`;
  const source = result.source === "session" ? "session" : result.source === "project" ? "project config" : "repo_paths";
  // The task has its own line (see formatTaskLine); keep this one to client and project.
  const { hubTaskId: _id, hubTaskTitle: _title, ...bare } = result.target;
  return `target: ${formatWorkTargetLabel(bare)} (source: ${source})`;
}

/** The `task:` line printed by `/kankaku:status` and `/kankaku:doctor`. */
export function formatTaskLine(result: ClaudeWorkTarget): string {
  if (result.target?.hubTaskTitle !== undefined) return `task: ${result.target.hubTaskTitle}`;
  if (result.droppedTask === undefined) return "task: none";
  const where = result.target?.projectName !== undefined ? `is not in project ${result.target.projectName}` : "needs a project";
  return `task: none (linked task "${result.droppedTask.title}" ${where})`;
}

export interface SessionWorkTargetDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  pid?: number;
  runPs?: (pid: number) => PsInfo | undefined;
}

/**
 * The work target for display (`status`, `doctor`): the folder's target plus
 * the task linked by the session this process runs under, when one is found.
 */
export function resolveSessionWorkTarget(deps: SessionWorkTargetDeps): ClaudeWorkTarget {
  const kankakuDir = resolveKankakuDir(deps.env.KANKAKU_DIR ?? ".kankaku", deps.cwd);
  const claudeDir = join(kankakuDir, "claude");
  const session = findSession({
    claudeDir, env: deps.env,
    ...(deps.pid !== undefined ? { pid: deps.pid } : {}),
    ...(deps.runPs !== undefined ? { runPs: deps.runPs } : {}),
  });
  const stored = session !== undefined ? readSessionTarget(resolveTargetFile(claudeDir, session)) : undefined;
  return resolveClaudeWorkTarget({
    cwd: deps.cwd, kankakuDir, homeDir: deps.env.HOME || homedir(), env: deps.env,
    ...(stored !== undefined ? sessionInputs(stored) : {}),
  });
}
