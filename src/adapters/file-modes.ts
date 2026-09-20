import { chmodSync, mkdirSync, statSync } from "node:fs";

/**
 * Every file kankaku writes under `~/.kankaku` (the machine-wide registry
 * `run/`, the catalog cache) carries absolute project paths, session ids, or
 * hub identifiers — restricted to the owner (F4). Not applied to a
 * project's own `<KANKAKU_DIR>` (`worklog.jsonl`, `inflight/`, …), which is
 * project-local, frequently committed alongside, and out of scope here.
 */
export const OWNER_DIR_MODE = 0o700;
export const OWNER_FILE_MODE = 0o600;

/**
 * Create `dir` (recursive) with `mode`, then best-effort tighten it when it
 * already existed with a looser mode — `mkdirSync`'s own `mode` option only
 * applies to a directory it actually creates in this call, never to one
 * that already existed (e.g. left by an older kankaku build, or a
 * permissive umask). Never throws: a permission-tightening failure must
 * never block the write this call exists to make.
 */
export function ensureDirMode(dir: string, mode: number = OWNER_DIR_MODE): void {
  mkdirSync(dir, { recursive: true, mode });
  tightenMode(dir, mode);
}

/** Best-effort `chmod` down to `mode` when the current mode is looser than it; never throws. */
export function tightenMode(path: string, mode: number = OWNER_FILE_MODE): void {
  try {
    const current = statSync(path).mode & 0o777;
    if ((current & ~mode) !== 0) chmodSync(path, mode);
  } catch {
    // Best effort: another process may have already removed the path, or
    // this filesystem does not support POSIX modes at all.
  }
}
