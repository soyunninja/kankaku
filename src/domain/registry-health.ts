/**
 * Decide which machine-wide {@link RegistryEntry} rows a sweep should keep
 * vs discard, and why. Pure, no I/O — `adapters/machine-process-registry.ts`
 * drives this with real `isAlive`/`liveStartId`/`now`, and
 * `adapters/kankaku-command.ts`'s `/kankaku doctor` reuses it (cheap mode,
 * no fresh identity re-verification) to report registry health.
 */

import { START_ID_TOLERANCE_MS } from "./ancestry-match.ts";
import type { RegistryEntry } from "../ports/process-registry.ts";

/** Sane last-resort ceiling on an entry's age, regardless of aliveness/identity: 7 days. */
export const DEFAULT_MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type DiscardReason =
  | "dead"
  /** The pid is alive, but its live start identity no longer matches what this entry recorded: the OS has reused this pid for a different process instance. */
  | "stale-reuse"
  /** The entry carries no `processStartId` at all (written by a build predating this field, or a torn/partial write) — its identity can never be proven, so it is never trusted regardless of aliveness. */
  | "unverifiable-identity"
  | "over-age";

export interface RegistryClassifyDeps {
  isAlive: (pid: number) => boolean;
  /** Live start identity for a pid, from the same ancestry snapshot the caller already took. `undefined` means "unknown" — never treated as evidence of reuse. */
  liveStartId: (pid: number) => number | undefined;
  now: number;
  maxAgeMs: number;
}

export interface RegistryClassification {
  keep: RegistryEntry[];
  discard: Array<{ entry: RegistryEntry; reason: DiscardReason }>;
}

/**
 * Classify every entry except `ownPid`'s (the caller's own, just-written
 * entry — always kept, never re-evaluated against its own freshly-recorded
 * data). An entry is discarded the first reason that applies, in this
 * order: dead pid; no verifiable `processStartId`; alive but identity
 * mismatched beyond {@link START_ID_TOLERANCE_MS} (pid reuse); older than
 * `maxAgeMs`. Anything else is kept.
 */
export function classifyRegistryEntries(entries: RegistryEntry[], ownPid: number, deps: RegistryClassifyDeps): RegistryClassification {
  const keep: RegistryEntry[] = [];
  const discard: RegistryClassification["discard"] = [];

  for (const entry of entries) {
    if (entry.pid === ownPid) {
      keep.push(entry);
      continue;
    }

    if (!deps.isAlive(entry.pid)) {
      discard.push({ entry, reason: "dead" });
      continue;
    }

    if (entry.processStartId === undefined) {
      discard.push({ entry, reason: "unverifiable-identity" });
      continue;
    }

    const liveId = deps.liveStartId(entry.pid);
    if (liveId !== undefined && Math.abs(liveId - entry.processStartId) > START_ID_TOLERANCE_MS) {
      discard.push({ entry, reason: "stale-reuse" });
      continue;
    }

    if (deps.now - Date.parse(entry.startedAt) > deps.maxAgeMs) {
      discard.push({ entry, reason: "over-age" });
      continue;
    }

    keep.push(entry);
  }

  return { keep, discard };
}
