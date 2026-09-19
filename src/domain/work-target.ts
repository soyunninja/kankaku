/**
 * Hub work-target resolution: pure, no I/O.
 *
 * A `WorkTarget` identifies who a piece of work is billed to (client) and,
 * optionally, which project it belongs to, both by PocketBase record id.
 * Names travel alongside for display; no aggregation ever keys on a name
 * (see `kankaku-pocketbase-proposal.md` D1).
 *
 * Resolution mirrors `client-label.ts#resolveClient`'s precedence pattern:
 * session > project config file > catalog `repo_paths` match for the cwd >
 * none. An id from any source that no longer resolves to an active,
 * non-"unassigned" catalog row is treated as absent for that source and
 * resolution falls through to the next one.
 */

export interface Client {
  id: string;
  name: string;
  code: string;
  active: boolean;
  /** `true` only for the single "Sin determinar" row; never offered by the picker. */
  unassigned?: boolean;
}

export interface Project {
  id: string;
  name: string;
  code?: string;
  clientId: string;
  /** Absolute paths that map to this project; enables auto-selection by cwd. */
  repoPaths: string[];
  active: boolean;
}

export interface WorkTarget {
  clientId: string;
  clientCode: string;
  clientName: string;
  projectId?: string;
  projectCode?: string;
  projectName?: string;
}

/** ids picked from the session, or from the project's `.kankaku/config.json`. */
export interface WorkTargetCandidate {
  clientId: string;
  projectId?: string;
}

/**
 * The session-level override: `undefined` when no session entry exists yet
 * (resolution falls through to the project/repo-paths sources), the literal
 * `"skipped"` when the user explicitly declined the picker (resolution
 * stops here, at "no target", and does not fall through), or explicit ids.
 */
export type WorkTargetSessionOverride = "skipped" | WorkTargetCandidate | undefined;

export interface ResolveWorkTargetInput {
  session?: WorkTargetSessionOverride;
  /** ids from the project's `.kankaku/config.json`. */
  project?: WorkTargetCandidate;
  /** Current working directory, matched against `Project.repoPaths`. */
  cwd: string;
  clients: Client[];
  projects: Project[];
}

export type WorkTargetSourceName = "session" | "project" | "repoPaths";

/** A client usable as a work target: exists, active, and not the "unassigned" row. */
function findUsableClient(clients: Client[], clientId: string): Client | undefined {
  const client = clients.find((candidate) => candidate.id === clientId);
  if (!client || !client.active || client.unassigned) return undefined;
  return client;
}

/** A project usable as a work target: exists, active, and belongs to `clientId`. */
function findUsableProject(projects: Project[], projectId: string, clientId: string): Project | undefined {
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project || !project.active || project.clientId !== clientId) return undefined;
  return project;
}

function buildTarget(client: Client, project: Project | undefined): WorkTarget {
  return {
    clientId: client.id,
    clientCode: client.code,
    clientName: client.name,
    ...(project !== undefined
      ? {
          projectId: project.id,
          ...(project.code !== undefined ? { projectCode: project.code } : {}),
          projectName: project.name,
        }
      : {}),
  };
}

/**
 * Resolve a candidate (from the session override or the project config
 * file) into a target, or `undefined` when the client id does not resolve
 * to a usable client. A projectId that does not resolve to a usable
 * project of that client is dropped — the client-only target is still
 * returned — rather than failing the whole candidate.
 */
function resolveCandidate(candidate: WorkTargetCandidate, clients: Client[], projects: Project[]): WorkTarget | undefined {
  const client = findUsableClient(clients, candidate.clientId);
  if (!client) return undefined;
  const project = candidate.projectId !== undefined ? findUsableProject(projects, candidate.projectId, client.id) : undefined;
  return buildTarget(client, project);
}

/** The longest-matching active project whose `repoPaths` contains `cwd`, exactly or as an ancestor directory. */
function matchByRepoPath(cwd: string, projects: Project[]): Project | undefined {
  let best: Project | undefined;
  let bestLength = -1;

  for (const project of projects) {
    if (!project.active) continue;
    for (const repoPath of project.repoPaths) {
      if (!isCwdWithin(cwd, repoPath)) continue;
      if (repoPath.length > bestLength) {
        bestLength = repoPath.length;
        best = project;
      }
    }
  }

  return best;
}

/** `true` when `cwd` equals `repoPath`, or is a subdirectory of it. */
function isCwdWithin(cwd: string, repoPath: string): boolean {
  if (cwd === repoPath) return true;
  const withSeparator = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
  return cwd.startsWith(withSeparator);
}

/** Which source (if any) {@link resolveWorkTarget} would use, computed independently so callers can display it. */
export function resolveWorkTargetSource(input: ResolveWorkTargetInput): WorkTargetSourceName | undefined {
  const { session } = input;
  if (session === "skipped") return undefined;
  if (session !== undefined && resolveCandidate(session, input.clients, input.projects) !== undefined) return "session";

  if (input.project !== undefined && resolveCandidate(input.project, input.clients, input.projects) !== undefined) return "project";

  const matched = matchByRepoPath(input.cwd, input.projects);
  if (matched && findUsableClient(input.clients, matched.clientId)) return "repoPaths";

  return undefined;
}

/**
 * Resolve the effective {@link WorkTarget}: session override > project
 * config file > catalog `repo_paths` match for `cwd` > none. A `"skipped"`
 * session override stops resolution immediately (the user explicitly
 * declined), returning `undefined` rather than falling through.
 */
export function resolveWorkTarget(input: ResolveWorkTargetInput): WorkTarget | undefined {
  const { session } = input;
  if (session === "skipped") return undefined;

  if (session !== undefined) {
    const resolved = resolveCandidate(session, input.clients, input.projects);
    if (resolved) return resolved;
  }

  if (input.project !== undefined) {
    const resolved = resolveCandidate(input.project, input.clients, input.projects);
    if (resolved) return resolved;
  }

  const matched = matchByRepoPath(input.cwd, input.projects);
  if (matched) {
    const client = findUsableClient(input.clients, matched.clientId);
    if (client) return buildTarget(client, matched);
  }

  return undefined;
}

/** `<clientName>` or `<clientName> · <projectName>` — the display label used by the status bar and the "remember" prompt. */
export function formatWorkTargetLabel(target: WorkTarget): string {
  return target.projectName ? `${target.clientName} · ${target.projectName}` : target.clientName;
}
