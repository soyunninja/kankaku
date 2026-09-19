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
  /** Injectable for tests; defaults to `os.homedir()` at the call site (extension.ts). */
  homeDir: string;
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
export function resolveHubCredentials(deps: ResolveHubCredentialsDeps): ResolveHubCredentialsResult {
  const fromEnv = loadHubEnvCredentials(deps.env);
  const fromFile = readCredentialsFile(join(deps.homeDir, CREDENTIALS_FILE));

  const url = fromEnv.url ?? fromFile.url;
  const email = fromEnv.email ?? fromFile.email;
  const password = fromEnv.password ?? fromFile.password;

  if (!url || !email || !password) return { credentials: undefined };

  const validation = validateHubUrl(url);
  if (!validation.ok) return { credentials: undefined, invalidReason: validation.reason };

  return { credentials: { url, email, password } };
}
