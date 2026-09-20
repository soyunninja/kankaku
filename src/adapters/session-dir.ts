/**
 * `SessionManager#usesDefaultSessionDir()`/`#getSessionDir()` are real
 * methods on pi's session manager (mirrors what pi's own
 * `formatResumeCommand` does to decide whether to print `--session-dir`),
 * but `usesDefaultSessionDir` is not part of the `ReadonlySessionManager`
 * type `ctx.sessionManager` is typed as — so this is a guarded duck-typed
 * call, not a typed one: an older pi version (or any future shape change)
 * that lacks the method degrades to "no sessionDir," never a crash.
 * Returns the session dir only when it is genuinely non-default, exactly
 * the condition under which pi itself would print `--session-dir`. Shared
 * by `pi-tracker.ts` (record metadata) and `kankaku-command.ts` (the
 * `/kankaku doctor` display) — kept as its own module so neither adapter
 * has to import the other.
 */
export function readNonDefaultSessionDir(sessionManager: unknown): string | undefined {
  const candidate = sessionManager as { usesDefaultSessionDir?: () => boolean; getSessionDir?: () => string };
  if (typeof candidate.usesDefaultSessionDir !== "function" || typeof candidate.getSessionDir !== "function") return undefined;
  try {
    if (candidate.usesDefaultSessionDir()) return undefined;
    const dir = candidate.getSessionDir();
    // An unpersisted session (e.g. `--no-session`) can report
    // usesDefaultSessionDir() === false with an empty getSessionDir() — not
    // a real custom directory, so there is nothing meaningful to carry.
    return dir ? dir : undefined;
  } catch {
    return undefined;
  }
}
