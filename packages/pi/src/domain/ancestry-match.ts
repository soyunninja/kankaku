import type { RegistryEntry } from "../ports/process-registry.ts";
import type { OrchestratorRef } from "./work-record.ts";

/**
 * Max allowed drift (ms) between a live process's freshly re-derived start
 * identity and the one recorded in its registry entry. Absorbs
 * second-granularity rounding/reading noise from the underlying OS
 * start-time source (`adapters/ancestry.ts`) — not a measure of real clock
 * error, since both readings of the *same* process instance stay tightly
 * consistent regardless of that source's own precision (see that module's
 * docs). A genuine pid-reuse produces a gap far larger than this.
 */
export const START_ID_TOLERANCE_MS = 2000;

/** Whether two start identities are close enough to be the same process instance. `undefined` on either side is always "no", never a coincidental match. */
function sameProcessInstance(recorded: number | undefined, live: number | undefined): boolean {
  if (recorded === undefined || live === undefined) return false;
  return Math.abs(recorded - live) <= START_ID_TOLERANCE_MS;
}

/**
 * The nearest tracked ancestor whose identity can actually be *proven*: the
 * first `ancestryPids` entry (ordered nearest-parent first, see
 * `adapters/ancestry.ts#walkAncestry`) that has a matching
 * {@link RegistryEntry} AND whose registry-recorded `processStartId`
 * agrees, within {@link START_ID_TOLERANCE_MS}, with `liveStartId(pid)` —
 * a fresh re-derivation of that same pid's actual OS start time, taken
 * from the same ancestry snapshot the caller already has. Matching by pid
 * number alone is not safe: the OS reuses pids, so a stale entry left
 * behind by a dead, never-cleaned-up process can otherwise be
 * misattributed to whatever unrelated live process the kernel later hands
 * that same pid to (a genuine top-level session silently misclassified as
 * someone's subagent forever). A candidate whose identity cannot be
 * verified — no `processStartId` on the entry (legacy/malformed), or no
 * live start id available for that pid (platform without ancestor-chain
 * support, or a snapshot gap) — is never matched; the walk continues past
 * it exactly like an untracked hop, so a further genuine ancestor can still
 * be found. Returns `undefined` when no ancestor pid is trackable at all —
 * callers must treat that exactly like "no registry available" (safe
 * fallback to the pre-registry behaviour), never invent a match.
 */
export function findAncestorEntry(ancestryPids: number[], entries: RegistryEntry[], liveStartId: (pid: number) => number | undefined): RegistryEntry | undefined {
  if (ancestryPids.length === 0 || entries.length === 0) return undefined;

  const byPid = new Map<number, RegistryEntry>();
  for (const entry of entries) {
    // First entry for a given pid wins; a pid should only ever have one
    // live registry file, but a torn write racing a sweep could in theory
    // leave two candidates behind — deterministic tie-break, not correctness-critical.
    if (!byPid.has(entry.pid)) byPid.set(entry.pid, entry);
  }

  for (const pid of ancestryPids) {
    const entry = byPid.get(pid);
    if (!entry) continue;
    if (sameProcessInstance(entry.processStartId, liveStartId(pid))) return entry;
    // Either unprovable, or this pid has genuinely been reused by a
    // different process instance since the entry was written: not our
    // ancestor. Keep walking — a further, verifiable ancestor may still exist.
  }
  return undefined;
}

/**
 * Resolve the ultimate, top-level {@link OrchestratorRef} for `ancestorEntry`
 * (the nearest verified ancestor {@link findAncestorEntry} returned) — F4's
 * nested-subagent fix. When that ancestor is itself a `subagent`-role entry
 * that already resolved its own verified `orchestratorRef` (a
 * subagent-of-subagent chain: this process's parent is itself someone's
 * child), that inherited ref is returned instead of one built from the
 * ancestor's own identity — so a grandchild's `orchestratorRef` (and, via
 * its `dir`, `extension.ts`'s F1 write-routing target) always points at
 * the real top-level orchestrator, never a middle hop. Falls back to an
 * ancestor's own identity when it is an orchestrator, or a subagent that
 * never resolved a ref of its own (e.g. it discovered no tracked ancestor
 * at its own startup) — never invents one. `undefined` in, `undefined` out.
 */
export function resolveOrchestratorRef(ancestorEntry: RegistryEntry | undefined): OrchestratorRef | undefined {
  if (ancestorEntry === undefined) return undefined;
  if (ancestorEntry.role === "subagent" && ancestorEntry.orchestratorRef !== undefined) {
    return ancestorEntry.orchestratorRef;
  }
  return { pid: ancestorEntry.pid, project: ancestorEntry.project, startedAt: ancestorEntry.startedAt, dir: ancestorEntry.dir };
}
