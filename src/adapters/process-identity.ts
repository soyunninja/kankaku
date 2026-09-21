import { detectRole, readRoleOverride, stripRoleOverride } from "../config.ts";
import type { RoleOverride } from "../config.ts";
import { resolveOrchestratorRef } from "../domain/ancestry-match.ts";
import type { OrchestratorRef } from "../domain/work-record.ts";
import type { ProcessRegistry, RegistryEntry } from "../ports/process-registry.ts";
import { resolveSubagentStartup } from "./subagent-startup.ts";
import type { AncestrySnapshot } from "./ancestry.ts";

/**
 * Everything about THIS OS process's identity that `role` (and everything
 * derived from it — `orchestratorRef`, F1's write-routing target) depends
 * on. Computed once by {@link resolveProcessIdentity}; see
 * `process-identity-memo.ts` for why a caller must never simply call this
 * again on a same-process factory re-invocation (G1).
 */
export interface ProcessIdentity {
  role: "orchestrator" | "subagent";
  /** `KANKAKU_ROLE`, as read BEFORE this call strips it from `deps.env` — never re-derivable afterwards. */
  roleOverride: RoleOverride | undefined;
  /** Whether `GENTLE_PI_AGENTS_CHILD=1` was present (never stripped, so re-reading `env` later would still agree — kept here anyway so every process-level fact lives in one place). */
  childMarkerPresent: boolean;
  /** See `config.ts#RoleDetection.overrideIgnoredInteractive`. */
  overrideIgnoredInteractive: true | undefined;
  /** Whether a live, identity-verified tracked ancestor was found via the machine-wide registry (F2/F3's `hasTrackedAncestor`). */
  hasTrackedAncestor: boolean;
  /** The nearest verified tracked ancestor's own registry entry, if any. */
  ancestorEntry: RegistryEntry | undefined;
  /** F4: the real top-level orchestrator's ref, resolved through a possible subagent-of-subagent chain. `undefined` for an `orchestrator`-role process. */
  orchestratorRef: OrchestratorRef | undefined;
  /** F5: this process's own OS start-time identity, derived without a subprocess spawn. */
  ownProcessStartId: number;
  /** Live start-identity lookup from the same ancestry snapshot `resolveSubagentStartup` took (or a fail-safe always-unknown function when it never took one — F5). */
  liveStartId: (pid: number) => number | undefined;
}

export interface ResolveProcessIdentityDeps {
  /** This process's own env. Mutated in place: the override is stripped after being read (R1, layer 2). */
  env: NodeJS.ProcessEnv;
  registry: ProcessRegistry;
  /** This process's own OS parent pid (`process.ppid`). */
  ppid: number;
  /** `Date.now`, injected. */
  now: () => number;
  /** `process.uptime`, injected. */
  uptimeSeconds: () => number;
  /** A cheap, synchronous interactivity proxy (`process.stdout.isTTY`) — see `config.ts#detectRole`'s doc comment. */
  isInteractiveGuess: boolean;
  /** Injectable for tests; forwarded to `resolveSubagentStartup`. */
  snapshotAncestry?: () => AncestrySnapshot;
}

/**
 * Compute this OS process's role/ancestry identity exactly once: reads
 * `KANKAKU_ROLE` and the confirmed-child marker, walks the machine-wide
 * registry/ancestor chain only when it could find something (F5), decides
 * `role` (R1's precedence), strips the override from `deps.env` so no
 * child this process spawns ever inherits it (R1, layer 2), and resolves
 * the verified `orchestratorRef` (F4) a subagent routes its writes to
 * (F1's write-routing target, alongside this process's own resolved dir —
 * see `extension.ts`).
 *
 * Mirrors what used to be inlined directly in `extension.ts` (and still is,
 * independently, in `scripts/e2e-cross-worktree-real-processes.ts`'s
 * `runStartup`, which exercises this exact sequence against real OS
 * processes) — pulled out into its own function so
 * `process-identity-memo.ts` (G1) can freeze its result across a
 * same-process factory re-invocation (`/new`/`/resume`/`/fork`/`/reload`)
 * without `extension.ts` duplicating this sequence, and so this exact
 * sequence has one place to be tested directly.
 */
export function resolveProcessIdentity(deps: ResolveProcessIdentityDeps): ProcessIdentity {
  const startup = resolveSubagentStartup({
    registry: deps.registry,
    ppid: deps.ppid,
    now: deps.now,
    uptimeSeconds: deps.uptimeSeconds,
    ...(deps.snapshotAncestry !== undefined ? { snapshotAncestry: deps.snapshotAncestry } : {}),
  });
  const hasTrackedAncestor = startup.ancestorEntry !== undefined;

  // R1 (BLOCKER): read KANKAKU_ROLE, and whether the confirmed child marker
  // is present, exactly once here — then strip the override from this
  // process's own env so a child this process spawns never inherits it.
  const childMarkerPresent = deps.env["GENTLE_PI_AGENTS_CHILD"] === "1";
  const roleOverride = readRoleOverride(deps.env);
  // `hasTrackedAncestor` is irrelevant to `role` itself (only to the
  // separately-deferred `roleConfidence`, resolved later by the caller),
  // so `false` is passed here purely to obtain `role`/`overrideIgnoredInteractive` cheaply.
  const detection = detectRole(deps.env, false, deps.isInteractiveGuess);
  const { role } = detection;
  const overrideIgnoredInteractive = detection.overrideIgnoredInteractive === true ? true : undefined;
  stripRoleOverride(deps.env);

  // F4: resolves through a subagent-of-subagent chain to the real top-level
  // orchestrator (never a middle hop), carrying that orchestrator's `dir`
  // for F1's write routing.
  const orchestratorRef = role === "subagent" ? resolveOrchestratorRef(startup.ancestorEntry) : undefined;

  return {
    role,
    roleOverride,
    childMarkerPresent,
    overrideIgnoredInteractive,
    hasTrackedAncestor,
    ancestorEntry: startup.ancestorEntry,
    orchestratorRef,
    ownProcessStartId: startup.ownProcessStartId,
    liveStartId: startup.liveStartId,
  };
}
