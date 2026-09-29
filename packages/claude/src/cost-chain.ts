export interface SettledCost {
  /** The prompt's cost; absent when it stays unobserved. */
  cost?: number;
  /** The new session baseline (the session total at this settle); absent when the baseline must not move. */
  baseline?: number;
}

/**
 * The chained per-prompt cost rule. `totalUsd` is the session total at
 * settle, `start` the total the prompt is measured from (the previous
 * settle's baseline, or the snapshot at submit for a session with none).
 *
 * - No finite total (headless, no statusline): nothing observed, baseline
 *   untouched.
 * - Total below the start: the counter was reset, so the cost is the total.
 * - Otherwise cost = total - start, in micro-dollars (no binary float noise).
 *
 * Node builtins only; safe on the light hook path.
 */
export function settleCost(totalUsd: number | undefined, start: number | undefined): SettledCost {
  if (typeof totalUsd !== "number" || !Number.isFinite(totalUsd)) return {};
  if (typeof start !== "number" || !Number.isFinite(start)) return { baseline: totalUsd };
  const raw = totalUsd < start ? totalUsd : totalUsd - start;
  return { cost: Math.max(0, Math.round(raw * 1e6) / 1e6), baseline: totalUsd };
}
