import { findAncestorEntry } from "../domain/ancestry-match.ts";
import type { ProcessRegistry, RegistryEntry } from "../ports/process-registry.ts";
import { ownStartIdFromUptime, snapshotAncestry, walkAncestry } from "./ancestry.ts";
import type { AncestrySnapshot } from "./ancestry.ts";

export interface SubagentStartupDeps {
  registry: ProcessRegistry;
  /** This process's own OS parent pid (`process.ppid`). */
  ppid: number;
  /** `Date.now`, injected. */
  now: () => number;
  /** `process.uptime`, injected. */
  uptimeSeconds: () => number;
  /** Injectable for tests; defaults to the real {@link snapshotAncestry}. */
  snapshotAncestry?: () => AncestrySnapshot;
}

export interface SubagentStartupResult {
  /** Every other kankaku process's registry entry visible at startup (this process has not written its own yet). */
  registryEntries: RegistryEntry[];
  /** The nearest verified tracked ancestor, if any — see `domain/ancestry-match.ts#findAncestorEntry`. */
  ancestorEntry: RegistryEntry | undefined;
  /** This process's own approximate OS start-time identity, derived with no subprocess spawn (F5). */
  ownProcessStartId: number;
  /**
   * Live start-identity lookup from the same ancestry snapshot taken above
   * (or, when no snapshot was needed — F5 — a function that always reports
   * "unknown", the same fail-safe default `RegistrySweepDeps.liveStartId`
   * itself documents). Reused by the caller's own `registry.record()` sweep
   * so registering this process's entry never pays for a *second* snapshot.
   */
  liveStartId: (pid: number) => number | undefined;
}

/**
 * Compose this process's ancestor-registry lookup at startup (F5: cheap in
 * the common case, never on a hot path after this). Reads the machine-wide
 * registry first — `registry.readAll()` never throws by its own port
 * contract, so nothing here defensively re-wraps it — and takes the one OS
 * ancestor-chain snapshot (a `ps` spawn or `/proc` scan) **only** when at
 * least one other entry exists that could possibly be an ancestor; when the
 * registry is empty, there is nothing an ancestor-chain walk could ever
 * find, so the snapshot is skipped entirely rather than paying its cost for
 * a result that would be `undefined` either way. This is the only place
 * `extension.ts` needs to call to learn "who (if anyone) is my tracked
 * ancestor, and what is my own start identity" — see also F1's write
 * routing (`domain/ancestry-match.ts#resolveOrchestratorRef`, which
 * consumes `ancestorEntry`) and F2/F3's role/interactivity decisions
 * (`config.ts#detectRole`, which consume `ancestorEntry !== undefined`).
 */
export function resolveSubagentStartup(deps: SubagentStartupDeps): SubagentStartupResult {
  const registryEntries = deps.registry.readAll();
  const ownProcessStartId = ownStartIdFromUptime(deps.now(), deps.uptimeSeconds());

  if (registryEntries.length === 0) {
    return { registryEntries, ancestorEntry: undefined, ownProcessStartId, liveStartId: () => undefined };
  }

  const takeSnapshot = deps.snapshotAncestry ?? snapshotAncestry;
  const snapshot = takeSnapshot();
  const ancestorPids = walkAncestry(deps.ppid, snapshot.ppidByPid);
  const liveStartId = (pid: number): number | undefined => snapshot.startIdByPid.get(pid);
  const ancestorEntry = findAncestorEntry(ancestorPids, registryEntries, liveStartId);

  return { registryEntries, ancestorEntry, ownProcessStartId, liveStartId };
}
