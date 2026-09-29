/**
 * The local hub's service account and where this machine's sync points.
 * Install always stores the service account in `~/.kankaku/hub/service.json`
 * (0600); `~/.kankaku/credentials.json` is a separate decision, made by
 * `installHub` (only when none exists or it already points here) and by
 * `useLocalHub` (`kankaku hub use`, explicit).
 */
import { existsSync, readFileSync } from "node:fs";
import { hubLayout, parseServiceAccount } from "../../domain/local-hub-model.ts";
import type { ServiceAccount } from "../../domain/local-hub-model.ts";
import { credentialsPath, writeHubCredentials } from "../setup/hub.ts";
import { readJsonObjectOrEmpty, writeJsonAtomic } from "../setup/json-writer.ts";

const OWNER_FILE_MODE = 0o600;

/** `~/.kankaku/hub/service.json`, or `undefined` when it is missing or malformed. Never throws. */
export function readServiceAccount(homeDir: string): ServiceAccount | undefined {
  const file = hubLayout(homeDir).serviceJson;
  if (!existsSync(file)) return undefined;
  try {
    return parseServiceAccount(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

/** Writes `account` to `~/.kankaku/hub/service.json` (0600, tmp + rename); a no-op when it already holds exactly these values. */
export function writeServiceAccount(homeDir: string, account: ServiceAccount): { changed: boolean } {
  const current = readServiceAccount(homeDir);
  if (current && current.url === account.url && current.email === account.email && current.password === account.password) return { changed: false };
  writeJsonAtomic(hubLayout(homeDir).serviceJson, { url: account.url, email: account.email, password: account.password }, undefined, OWNER_FILE_MODE);
  return { changed: true };
}

/** The `url` currently in `~/.kankaku/credentials.json`, or `undefined` when there is none. */
export function readCredentialsUrl(homeDir: string): string | undefined {
  const url = readJsonObjectOrEmpty(credentialsPath(homeDir))["url"];
  return typeof url === "string" && url !== "" ? url : undefined;
}

export type UseLocalHubResult = { ok: true; changed: boolean; url: string; previousUrl?: string } | { ok: false; error: string };

/**
 * `kankaku hub use`: points `credentials.json` at the local hub's service
 * account (`service.json`), keeping the one-time `.bak` of the previous
 * file. Needs an installed local hub and its `service.json`; idempotent.
 */
export function useLocalHub(homeDir: string): UseLocalHubResult {
  const layout = hubLayout(homeDir);
  if (!existsSync(layout.hubJson)) {
    return { ok: false, error: "no local hub is installed; run: kankaku hub install" };
  }
  const service = readServiceAccount(homeDir);
  if (!service) {
    return {
      ok: false,
      error: "the local hub has no service.json (an install made by an older version does not write one); run 'kankaku hub install' again - it is idempotent and writes it when the service password is still known",
    };
  }
  const previousUrl = readCredentialsUrl(homeDir);
  const written = writeHubCredentials(homeDir, service);
  return { ok: true, changed: written.changed, url: service.url, ...(previousUrl !== undefined ? { previousUrl } : {}) };
}
