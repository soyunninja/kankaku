import type { RegistryEntry } from "../ports/process-registry.ts";

/**
 * The nearest tracked ancestor: the first `ancestryPids` entry (ordered
 * nearest-parent first, see `adapters/ancestry.ts#walkAncestry`) that has a
 * matching {@link RegistryEntry}, or `undefined` when none of them do. A
 * shell-wrapper hop with no registry entry of its own is walked past, not
 * stopped at (SUBAGENT-REQ-011), since `ancestryPids` already spans every
 * hop up to the walk's limit.
 */
export function findAncestorEntry(ancestryPids: number[], entries: RegistryEntry[]): RegistryEntry | undefined {
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
    if (entry) return entry;
  }
  return undefined;
}
