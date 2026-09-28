/**
 * Shared write primitives for every `setup` writer: read-existing-or-{},
 * atomic tmp+rename, and a one-time `<file>.bak` — mirrors kankaku's own
 * `adapters/project-config.ts#writeProjectTargetIds`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OWNER_FILE_MODE = 0o600;

/** Parse `filePath` as a JSON object, defaulting to `{}` on any absence, malformed JSON, or non-object document. Never throws. */
export function readJsonObjectOrEmpty(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Best-effort `chmodSync`; never throws (e.g. a read-only filesystem or an already-gone file). */
function tightenBestEffort(path: string): void {
  try {
    chmodSync(path, OWNER_FILE_MODE);
  } catch {
    // Best-effort only.
  }
}

/**
 * Copy `filePath`'s current bytes to `<filePath>.bak`, but only the first
 * time: a no-op when `filePath` does not exist yet (nothing to back up) or
 * `<filePath>.bak` already exists (its content is never overwritten).
 *
 * When `filePath` is owner-only (0600, e.g. `~/.kankaku/credentials.json`,
 * which carries a live hub's service account password), the backup mirrors
 * that mode instead of the platform's default (umask-derived, typically
 * world-readable) mode — a previous hub's credentials must never end up
 * more exposed in the backup than they were in the live file. An existing
 * `.bak` from before this fix is tightened too, best-effort, whenever a
 * 0600 source is encountered — mirroring kankaku's own "existing looser
 * mode is tightened, best-effort, whenever encountered" rule.
 */
export function backupOnce(filePath: string): void {
  if (!existsSync(filePath)) return;
  const backupPath = `${filePath}.bak`;
  const sourceIsOwnerOnly = (statSync(filePath).mode & 0o777) === OWNER_FILE_MODE;

  if (existsSync(backupPath)) {
    if (sourceIsOwnerOnly) tightenBestEffort(backupPath);
    return;
  }

  // Created owner-only from the first byte when the source is: a chmod
  // after the write would leave a window where the secret is readable.
  writeFileSync(backupPath, readFileSync(filePath), sourceIsOwnerOnly ? { mode: OWNER_FILE_MODE } : {});
  if (sourceIsOwnerOnly) tightenBestEffort(backupPath);
}

/** Write `value` as 2-space-indented JSON to `filePath` via tmp file + rename, creating the parent directory when missing. */
export function writeJsonAtomic(filePath: string, value: unknown, dirMode?: number): void {
  mkdirSync(dirname(filePath), dirMode !== undefined ? { recursive: true, mode: dirMode } : { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, filePath);
}
