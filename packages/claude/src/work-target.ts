import { join } from "node:path";
import {
  CachedCatalog, readProjectClient, readProjectTargetIds, resolveHubCredentials,
} from "kankaku/hub";
import {
  formatWorkTargetLabel, isValidClient, resolveClient, resolveWorkTarget, resolveWorkTargetSource,
} from "kankaku/domain";
import type { WorkTarget } from "kankaku/domain";

export interface ClaudeWorkTargetInput {
  /** The session's working directory, matched against the catalog's `repo_paths`. */
  cwd: string;
  /** The project's kankaku dir (holds `config.json`). */
  kankakuDir: string;
  /** Home directory holding `.kankaku/catalog.json` and `.kankaku/credentials.json`. */
  homeDir: string;
  env: NodeJS.ProcessEnv;
}

/** What a record needs stamped: the hub target and the legacy `client` label. */
export interface RecordAssignment {
  target?: WorkTarget;
  /** Legacy free-text `client` label; omitted when none resolves or the code is invalid. */
  legacyClient?: string;
}

export interface ClaudeWorkTarget extends RecordAssignment {
  source?: "project" | "repoPaths";
  /** Why there is no target; set only when {@link ClaudeWorkTarget.target} is absent. */
  reason?: string;
}

/**
 * Resolves the work target for a session, for record stamping and display.
 *
 * Sources, in order: the project's `config.json` ids, then the cached
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
  const withLegacy = (result: ClaudeWorkTarget): ClaudeWorkTarget =>
    legacyFallback !== undefined ? { ...result, legacyClient: legacyFallback } : result;

  const snapshot = readCatalogCache(input);
  if (!snapshot) return withLegacy({ reason: "no catalog cache" });

  const resolveInput = {
    project: readProjectTargetIds(input.kankakuDir),
    cwd: input.cwd,
    clients: snapshot.clients,
    projects: snapshot.projects,
  };
  const target = resolveWorkTarget(resolveInput);
  const source = resolveWorkTargetSource(resolveInput);
  if (!target || (source !== "project" && source !== "repoPaths")) {
    return withLegacy({ reason: `no match for ${input.cwd}` });
  }
  // Mirrors the pi extension: with a hub target the legacy label is the
  // client's code, omitted when it is not a valid label.
  return {
    target,
    source,
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
  const source = result.source === "project" ? "project config" : "repo_paths";
  return `target: ${formatWorkTargetLabel(result.target)} (source: ${source})`;
}
