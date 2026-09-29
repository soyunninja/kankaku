import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// U+FE0F forces emoji presentation so terminals do not fall back to monochrome text glyphs.
const CLOCK_EMOJI = "\u{1F552}️";
const CLIENT_EMOJI = "\u{1F4BC}️";

/** Footer status key; footer statuses are sorted alphabetically by key, "zz-" keeps kankaku last. */
export const STATUS_KEY = "zz-kankaku";

export function formatElapsed(ms: number, client?: string): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const elapsed = `${CLOCK_EMOJI} ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return client ? `${elapsed} · ${client}` : elapsed;
}

export interface StatusBarDeps {
  /** Status line refresh interval in ms while a run is active. Defaults to 1000. */
  intervalMs?: number;
  /** Resolve the client label to show for the run that is starting now. */
  resolveRunClient: () => string | undefined;
  /** Resolve the client label to show while idle. */
  resolveIdleClient: () => string | undefined;
  /** Injectable for tests; defaults to the global timer functions. */
  setInterval?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface StatusBar {
  /** Start (or, if already running, leave untouched) the elapsed-time status; a no-op without a UI. */
  start(ctx: ExtensionContext): void;
  /** Stop the elapsed-time status and fall back to the idle status. */
  stop(ctx: ExtensionContext): void;
  /** While idle, keep the billing client visible (`💼 <client>`), or clear the status when none resolves. */
  showIdle(ctx: ExtensionContext): void;
}

/**
 * Owns the `/kankaku` footer status: the running elapsed-time clock (with
 * its refresh timer) while a run is active, and the idle billing-client
 * label otherwise.
 */
export function createStatusBar(deps: StatusBarDeps): StatusBar {
  const intervalMs = deps.intervalMs ?? 1000;
  const scheduleInterval = deps.setInterval ?? setInterval;
  const cancelInterval = deps.clearInterval ?? clearInterval;
  const now = deps.now ?? Date.now;

  let runStartedAt: number | undefined;
  let statusTimer: NodeJS.Timeout | undefined;

  function showIdle(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const client = deps.resolveIdleClient();
    ctx.ui.setStatus(STATUS_KEY, client ? `${CLIENT_EMOJI} ${client}` : undefined);
  }

  function start(ctx: ExtensionContext): void {
    // Retries within the same run fire before_agent_start again; only the
    // first one starts the timer.
    if (runStartedAt !== undefined) return;
    if (!ctx.hasUI) return;
    runStartedAt = now();
    const client = deps.resolveRunClient();
    ctx.ui.setStatus(STATUS_KEY, formatElapsed(0, client));
    statusTimer = scheduleInterval(() => {
      if (runStartedAt === undefined) return;
      ctx.ui.setStatus(STATUS_KEY, formatElapsed(now() - runStartedAt, client));
    }, intervalMs);
    statusTimer.unref?.();
  }

  function stop(ctx: ExtensionContext): void {
    if (statusTimer) {
      cancelInterval(statusTimer);
      statusTimer = undefined;
    }
    runStartedAt = undefined;
    showIdle(ctx);
  }

  return { start, stop, showIdle };
}
