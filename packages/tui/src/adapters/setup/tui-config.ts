/**
 * Setup-only writer for `~/.kankaku/tui.json`. Reading it for normal
 * (non-setup) use is `adapters/tui-config.ts#readTuiConfig` — this file
 * only ever writes.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { backupOnce, readJsonObjectOrEmpty, writeJsonAtomic } from "./json-writer.ts";

const OWNER_DIR_MODE = 0o700;

export interface PackagesWriteResult {
  changed: boolean;
}

export function tuiConfigPath(homeDir: string): string {
  return join(homeDir, ".kankaku", "tui.json");
}

function sameRoots(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Write `{ roots }` to `<homeDir>/.kankaku/tui.json`, preserving any other
 * existing key. `~/.kankaku` is created 0700 only when it does not exist
 * yet (never chmod'd otherwise — see `setup/hub.ts#writeHubCredentials`).
 * A no-op, with no backup and no write, when `roots` already matches
 * exactly.
 */
export function writeTuiConfig(homeDir: string, roots: string[]): PackagesWriteResult {
  const dir = join(homeDir, ".kankaku");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: OWNER_DIR_MODE });

  const filePath = tuiConfigPath(homeDir);
  const existing = readJsonObjectOrEmpty(filePath);
  if (existsSync(filePath) && sameRoots(existing["roots"], roots)) return { changed: false };

  backupOnce(filePath);
  writeJsonAtomic(filePath, { ...existing, roots });
  return { changed: true };
}
