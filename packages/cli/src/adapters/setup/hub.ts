/**
 * Setup-only hub adapter: writes `~/.kankaku/credentials.json` and checks
 * the hub's health endpoint. Reading hub credentials for normal (non-setup)
 * use is `adapters/hub.ts#resolveHub`, wrapping kankaku's own
 * `resolveHubCredentials` — this file only ever writes.
 */
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { backupOnce, readJsonObjectOrEmpty, writeJsonAtomic } from "./json-writer.ts";

const OWNER_DIR_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

export interface HubCredentialsInput {
  url: string;
  email: string;
  password: string;
}

export interface PackagesWriteResult {
  changed: boolean;
}

export function credentialsPath(homeDir: string): string {
  return join(homeDir, ".kankaku", "credentials.json");
}

/**
 * Write `credentials` to `<homeDir>/.kankaku/credentials.json`, 0600.
 * `~/.kankaku` is created 0700 only when it does not exist yet — an
 * already-existing `~/.kankaku` (shared with kankaku's own worklog
 * storage) is never chmod'd, mirroring kankaku's own R2 rule. A no-op,
 * with no backup and no write, when the file already holds these exact
 * values.
 */
export function writeHubCredentials(homeDir: string, credentials: HubCredentialsInput): PackagesWriteResult {
  const dir = join(homeDir, ".kankaku");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: OWNER_DIR_MODE });

  const filePath = credentialsPath(homeDir);
  const existing = readJsonObjectOrEmpty(filePath);
  const unchanged =
    existsSync(filePath) && existing["url"] === credentials.url && existing["email"] === credentials.email && existing["password"] === credentials.password;
  if (unchanged) return { changed: false };

  backupOnce(filePath);
  writeJsonAtomic(filePath, { ...existing, url: credentials.url, email: credentials.email, password: credentials.password });
  chmodSync(filePath, OWNER_FILE_MODE);
  return { changed: true };
}

export interface HealthCheckDeps {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to 5000ms. */
  timeoutMs?: number;
}

/** `GET <url>/api/health` under a timeout (default 5s); `true` only on an ok response, `false` on any error, non-ok status, or timeout. Never throws. */
export async function checkHubHealth(url: string, deps: HealthCheckDeps = {}): Promise<boolean> {
  const doFetch = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000);
  try {
    const response = await doFetch(`${url.replace(/\/+$/, "")}/api/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
