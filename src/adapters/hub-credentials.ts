import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadHubEnvCredentials, validateHubUrl } from "../config.ts";

const CREDENTIALS_FILE = join(".kankaku", "credentials.json");

export interface HubCredentials {
  url: string;
  email: string;
  password: string;
}

interface HubCredentialsFile {
  url?: string;
  email?: string;
  password?: string;
}

/**
 * Read `<homeDir>/.kankaku/credentials.json`. Tolerates a missing file,
 * malformed JSON, a non-object document, or non-string fields — all
 * return `{}` rather than throwing, since this file is optional and
 * hand-edited (mirrors `project-config.ts#readProjectClient`).
 */
function readCredentialsFile(filePath: string): HubCredentialsFile {
  if (!existsSync(filePath)) return {};

  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      url: typeof record["url"] === "string" ? record["url"] : undefined,
      email: typeof record["email"] === "string" ? record["email"] : undefined,
      password: typeof record["password"] === "string" ? record["password"] : undefined,
    };
  } catch {
    return {};
  }
}

export interface ResolveHubCredentialsDeps {
  env: NodeJS.ProcessEnv;
  /**
   * Resolves the home directory; called lazily, inside this function, and
   * defensively. A throwing provider (no `HOME`, a sandboxed environment
   * without a resolvable home directory) is treated the same as "no home
   * directory" rather than propagating — env-only credentials must still
   * resolve, and the hub-unconfigured case must stay a no-op regardless of
   * the host environment. Injectable for tests; defaults to `os.homedir` at
   * the call site (extension.ts) — passed as a reference, never invoked
   * there, so a throw never escapes before this function's own try/catch.
   */
  homeDir: () => string;
}

export interface ResolveHubCredentialsResult {
  /** `undefined` when unconfigured (no url/email/password from any source) or the URL is refused. */
  credentials: HubCredentials | undefined;
  /** Set only when a hub URL was given but rejected by {@link validateHubUrl}; surface it once via `ctx.ui.notify`. */
  invalidReason?: string;
}

/**
 * Resolve hub credentials: `KANKAKU_PB_URL`/`_EMAIL`/`_PASSWORD` take
 * precedence per field over `~/.kankaku/credentials.json` (so a partially
 * set environment still combines with the file rather than failing
 * closed). Never reads the project's own `.kankaku/config.json` — that
 * file is project-local and frequently committed.
 */
/** Resolve `homeDir()` defensively: any failure (no `HOME`, a sandboxed environment) yields `undefined` instead of throwing. Exported so callers with their own homedir-dependent path (e.g. `extension.ts`'s catalog cache) can share the same guard. */
export function safeHomeDir(homeDir: () => string): string | undefined {
  try {
    return homeDir();
  } catch {
    return undefined;
  }
}

export function resolveHubCredentials(deps: ResolveHubCredentialsDeps): ResolveHubCredentialsResult {
  const fromEnv = loadHubEnvCredentials(deps.env);
  const homeDir = safeHomeDir(deps.homeDir);
  const fromFile = homeDir !== undefined ? readCredentialsFile(join(homeDir, CREDENTIALS_FILE)) : {};

  const url = fromEnv.url ?? fromFile.url;
  const email = fromEnv.email ?? fromFile.email;
  const password = fromEnv.password ?? fromFile.password;

  if (!url || !email || !password) return { credentials: undefined };

  const validation = validateHubUrl(url);
  if (!validation.ok) return { credentials: undefined, invalidReason: validation.reason };

  return { credentials: { url, email, password } };
}
