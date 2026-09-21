import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Matches this probe's own marker filename: `.kankaku-write-probe.<pid>.<timestamp>.tmp`. */
const PROBE_NAME_PATTERN = /^\.kankaku-write-probe\.\d+\.(\d+)\.tmp$/;
/** A marker older than this is assumed abandoned (its writer was SIGKILLed between the write and its own unlink) — R4. */
const PROBE_STALE_MS = 60_000;

/**
 * Best-effort removal of a stale writability-probe marker (R4): a probe
 * that gets SIGKILLed between its `writeFileSync` and its own `unlinkSync`
 * leaves `.kankaku-write-probe.<pid>.<timestamp>.tmp` behind forever —
 * nothing else in `dir` ever looks at it again otherwise. Runs
 * opportunistically every time the probe itself runs (mirrors
 * `machine-process-registry.ts`'s own-write-time sweep pattern), so no
 * separate cleanup process is needed. Only removes a marker whose
 * filename-embedded timestamp (not the file's mtime, so this stays
 * deterministic and easy to test) is older than a minute — never a fresh
 * one, including this call's own marker (written after this sweep runs) or
 * a concurrent process's own in-flight probe.
 */
function sweepStaleWriteProbes(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir just created and already empty, or unreadable — nothing to sweep.
  }

  for (const name of names) {
    const match = PROBE_NAME_PATTERN.exec(name);
    if (!match) continue;
    const timestamp = Number(match[1]);
    if (!Number.isFinite(timestamp) || now - timestamp <= PROBE_STALE_MS) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Best effort: already gone, or a concurrent sweep got there first.
    }
  }
}

/** `mkdirSync` + a temp marker file write/unlink: proves both creatability and write permission, not just existence (a read-only *existing* directory would otherwise pass a bare `mkdirSync` check silently, since recursive mkdir on an existing dir never fails). Also sweeps any stale marker left behind by an earlier, SIGKILLed probe (R4) before writing its own. */
function defaultWritabilityProbe(dir: string): void {
  mkdirSync(dir, { recursive: true });
  sweepStaleWriteProbes(dir, Date.now());
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
