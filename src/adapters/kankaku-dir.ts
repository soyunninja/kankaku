import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Resolve the kankaku data directory: an absolute `dirOrRelative` is used
 * as-is, a relative one is joined against `cwd`. Shared by every lazy
 * adapter so the rule lives in exactly one place.
 */
export function resolveKankakuDir(dirOrRelative: string, cwd: string): string {
  return isAbsolute(dirOrRelative) ? dirOrRelative : join(cwd, dirOrRelative);
}

export interface WritableTargetResult {
  dir: string;
  /** `true` when `candidateDir` failed its writability probe and `dir` is `fallbackDir` instead. */
  usedFallback: boolean;
}

export interface ResolveWritableTargetDeps {
  /**
   * Proves this process can actually write to `dir` — not merely that it
   * exists — and throws on any failure. Injectable for tests (never touch
   * real disk to simulate an unwritable directory); defaults to
   * {@link defaultWritabilityProbe}.
   */
  probe?: (dir: string) => void;
}

/** `mkdirSync` + a temp marker file write/unlink: proves both creatability and write permission, not just existence (a read-only *existing* directory would otherwise pass a bare `mkdirSync` check silently, since recursive mkdir on an existing dir never fails). */
function defaultWritabilityProbe(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, `.kankaku-write-probe.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(marker, "");
  unlinkSync(marker);
}

/**
 * Resolve the target directory for a write that would normally go to
 * `candidateDir` (F1: routing a verified subagent's work log/inflight
 * checkpoints to its orchestrator's kankaku directory instead of its own
 * cwd-relative one — ADR 0023's rewrite): `candidateDir` when it can be
 * proven writable — created if it does not exist yet — `fallbackDir` (the
 * process's own local directory) otherwise, so a parent directory that no
 * longer exists, or that this process lacks permission to write to,
 * degrades to a safe, local fallback instead of throwing and losing the
 * record entirely. `usedFallback` lets the caller surface this (`/kankaku
 * doctor`) so a human can notice and reunite the record manually — the
 * append-only log can never be rewritten to fix it after the fact. Never
 * throws: `fallbackDir` itself is never probed here — its own writability
 * is handled the ordinary way, by whichever adapter eventually writes to
 * it, exactly as it always has been for a process that never needed to
 * route anywhere.
 */
export function resolveWritableTarget(candidateDir: string, fallbackDir: string, deps: ResolveWritableTargetDeps = {}): WritableTargetResult {
  const probe = deps.probe ?? defaultWritabilityProbe;
  try {
    probe(candidateDir);
    return { dir: candidateDir, usedFallback: false };
  } catch {
    return { dir: fallbackDir, usedFallback: true };
  }
}
