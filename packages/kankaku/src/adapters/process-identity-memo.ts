import { resolveProcessIdentity } from "./process-identity.ts";
import type { ProcessIdentity, ResolveProcessIdentityDeps } from "./process-identity.ts";

/**
 * Freezes {@link resolveProcessIdentity}'s result for the lifetime of one
 * OS process (G1, HIGH — verified): pi re-invokes an extension's factory
 * function IN THE SAME OS PROCESS on `/new`, `/resume`, `/fork` and
 * `/reload` ("reloads and rebinds extensions for the new session" — see
 * `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`). Every
 * fact `resolveProcessIdentity` computes is about the OS PROCESS, not the
 * pi session running inside it, and several of them can only ever be read
 * correctly once:
 *
 * - `roleOverride` (`KANKAKU_ROLE`, read before this call strips it from
 *   `process.env` so no spawned child ever inherits it — R1, layer 2): a
 *   second invocation would read `undefined` (already stripped by the
 *   first), silently losing an explicit `KANKAKU_ROLE=orchestrator` force —
 *   exactly the bug this module fixes. Without freezing, a forced
 *   orchestrator whose process happens to have a tracked ancestor (e.g. it
 *   was itself launched from inside another pi's shell tool) would fall
 *   back to ordinary detection on session 2 and could be demoted to
 *   `roleConfidence: "uncertain"`, silently dropping genuine billable work.
 * - `hasTrackedAncestor`/`ancestorEntry` (the machine-wide registry +
 *   OS-ancestor-chain walk, F5): this process's ancestor chain is fixed at
 *   OS-process-creation time and does not change for the life of the
 *   process; re-walking it on every reload would also re-spawn a `ps`/
 *   `/proc` read each time for no benefit (F5's whole point is to avoid
 *   exactly that).
 * - `ownProcessStartId` (F5's spawn-free own-identity estimate,
 *   `now - uptime`): a fresh reading on invocation 2 is a slightly
 *   different point-estimate of the same real start time as invocation 1's
 *   — usually well within `ancestry-match.ts#START_ID_TOLERANCE_MS`, but
 *   several `process.on("exit")` listeners (see below) each holding a
 *   *different* estimate risk `removeOwn`'s exact-match check silently
 *   failing to clean up the registry entry the LAST `record()` call
 *   actually wrote. Freezing it means every invocation's registry write —
 *   and any later cleanup — always agrees on the exact same value.
 *
 * Session-level facts are deliberately NOT frozen here and must be
 * re-evaluated by the caller every invocation: interactive mode from
 * `ctx.mode` (only known later, at `session_start`), and the session's
 * project/client target (`process.cwd()` can legitimately differ between
 * sessions in the same process — see `extensions.md`'s trust-resolution
 * note on `/resume` entering a new cwd — so `extension.ts` still calls
 * `resolveKankakuDir` fresh every invocation).
 *
 * Kept as a small, explicitly injectable holder (never module-level mutable
 * state read directly by a domain type) so a test can construct its own
 * memo, and so production code goes through exactly one shared, real
 * process-wide instance (see {@link getProcessIdentityMemo}).
 */
export interface ProcessIdentityMemo {
  /**
   * Returns the frozen facts, computing them (and freezing whatever they
   * are) on the first call this memo instance ever receives; every later
   * call ignores `deps` entirely and returns the exact same object.
   */
  resolve(deps: ResolveProcessIdentityDeps): ProcessIdentity;
  /**
   * Registers `cleanup` with `on` at most once across every call this memo
   * instance ever receives — the fix for the sibling leak this finding
   * flagged: `extension.ts` used to call `process.on("exit", ...)`
   * unconditionally on every factory invocation, piling up one listener per
   * `/new`/`/resume`/`/fork`/`/reload` (each running `removeOwn`
   * needlessly, though harmlessly, since it is idempotent — the real risk
   * is an unbounded listener count over a long-lived interactive session).
   * `on` takes the listener directly (never the event name) so a test can
   * inject a plain recording function instead of touching the real
   * `process` object.
   */
  registerExitCleanupOnce(on: (listener: () => void) => void, cleanup: () => void): void;
}

export function createProcessIdentityMemo(): ProcessIdentityMemo {
  let facts: ProcessIdentity | undefined;
  let exitCleanupRegistered = false;

  return {
    resolve(deps: ResolveProcessIdentityDeps): ProcessIdentity {
      if (facts === undefined) facts = resolveProcessIdentity(deps);
      return facts;
    },
    registerExitCleanupOnce(on: (listener: () => void) => void, cleanup: () => void): void {
      if (exitCleanupRegistered) return;
      exitCleanupRegistered = true;
      on(cleanup);
    },
  };
}

// The real, process-wide singleton `extension.ts` uses in production: one
// module-level instance, reused by every factory invocation in this OS
// process — which is the entire point (see the class doc above). A test
// must never rely on this singleton (module state would leak between test
// files run in the same worker); construct a fresh memo via
// `createProcessIdentityMemo()` instead.
let processWideMemo: ProcessIdentityMemo = createProcessIdentityMemo();

/** The real, process-wide {@link ProcessIdentityMemo} `extension.ts` reads and writes on every factory invocation. */
export function getProcessIdentityMemo(): ProcessIdentityMemo {
  return processWideMemo;
}
