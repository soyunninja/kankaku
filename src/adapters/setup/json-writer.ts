/**
 * Shared write primitives for every `setup` writer: read-existing-or-{},
 * atomic tmp+rename, and a one-time `<file>.bak` — mirrors kankaku's own
 * `adapters/project-config.ts#writeProjectTargetIds`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

/**
 * Copy `filePath`'s current bytes to `<filePath>.bak`, but only the first
 * time: a no-op when `filePath` does not exist yet (nothing to back up) or
 * `<filePath>.bak` already exists (never overwritten).
 */
export function backupOnce(filePath: string): void {
  if (!existsSync(filePath)) return;
  const backupPath = `${filePath}.bak`;
  if (existsSync(backupPath)) return;
  writeFileSync(backupPath, readFileSync(filePath));
}

/** Write `value` as 2-space-indented JSON to `filePath` via tmp file + rename, creating the parent directory when missing. */
export function writeJsonAtomic(filePath: string, value: unknown, dirMode?: number): void {
  mkdirSync(dirname(filePath), dirMode !== undefined ? { recursive: true, mode: dirMode } : { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, filePath);
}
