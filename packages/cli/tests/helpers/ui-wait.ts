/**
 * Waiting helpers for UI tests. A test never waits for a fixed time: it
 * waits for a condition (`waitFor`) or for the rendered frame to stop
 * changing (`settle`), so a slow runner only makes it wait longer, never
 * fail. A genuinely failing test still fails, with its own assertion
 * message, once `timeoutMs` has passed.
 */

export interface WaitOptions {
  /** Give up after this long. Defaults to 3000 ms. */
  timeoutMs?: number;
  /** Poll period. Defaults to 10 ms. */
  intervalMs?: number;
}

export interface SettleOptions extends WaitOptions {
  /** How long the frame must stay unchanged. Defaults to 60 ms. */
  quietMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `assertion` repeatedly until it stops throwing (sync or async).
 * Rethrows the LAST error when `timeoutMs` expires, so the failure message
 * is the assertion's own.
 */
export async function waitFor(assertion: () => void | Promise<void>, options: WaitOptions = {}): Promise<void> {
  const { timeoutMs = 3000, intervalMs = 10 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await sleep(intervalMs);
  }
}

/**
 * Resolve once the rendered frame (`lastFrame()`) has not changed for
 * `quietMs`. Rejects if it keeps changing past `timeoutMs`.
 */
export async function settle(lastFrame: () => string | undefined, options: SettleOptions = {}): Promise<void> {
  const { quietMs = 60, timeoutMs = 3000, intervalMs = 10 } = options;
  const deadline = Date.now() + timeoutMs;
  let previous = lastFrame();
  let changedAt = Date.now();
  for (;;) {
    await sleep(intervalMs);
    const current = lastFrame();
    const now = Date.now();
    if (current !== previous) {
      previous = current;
      changedAt = now;
    } else if (now - changedAt >= quietMs) {
      return;
    }
    if (now >= deadline) throw new Error(`the frame did not settle within ${timeoutMs}ms`);
  }
}
