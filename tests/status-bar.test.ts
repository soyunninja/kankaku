import assert from "node:assert/strict";
import { test } from "node:test";
import { createStatusBar, formatElapsed, STATUS_KEY } from "../src/adapters/status-bar.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CLOCK = "\u{1F552}️";
const CLIENT = "\u{1F4BC}️";

function makeCtx(hasUI: boolean, statusCalls: Array<[string, string | undefined]>): ExtensionContext {
  return {
    hasUI,
    ui: {
      notify: () => {},
      setStatus: (key: string, value: string | undefined) => statusCalls.push([key, value]),
    },
  } as unknown as ExtensionContext;
}

/** A fake `setInterval`/`clearInterval` pair that never fires on its own; the test invokes the captured handler. */
function makeFakeScheduler() {
  let scheduled: { handler: () => void; ms: number } | undefined;
  let cancelled = 0;
  return {
    setInterval: (handler: () => void, ms: number): NodeJS.Timeout => {
      scheduled = { handler, ms };
      return {} as NodeJS.Timeout;
    },
    clearInterval: (): void => {
      cancelled += 1;
    },
    fire: (): void => scheduled?.handler(),
    get scheduledMs(): number | undefined {
      return scheduled?.ms;
    },
    get cancelledCount(): number {
      return cancelled;
    },
  };
}

test("formatElapsed formats mm:ss with the clock emoji, and appends the client when given", () => {
  assert.equal(formatElapsed(0), `${CLOCK} 00:00`);
  assert.equal(formatElapsed(65000), `${CLOCK} 01:05`);
  assert.equal(formatElapsed(1000, "acme"), `${CLOCK} 00:01 · acme`);
});

test("start sets the elapsed status immediately and schedules a refresh at the given interval", () => {
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeCtx(true, statusCalls);
  const scheduler = makeFakeScheduler();
  let now = 1000;

  const bar = createStatusBar({
    intervalMs: 500,
    resolveRunClient: () => "acme",
    resolveIdleClient: () => undefined,
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval,
    now: () => now,
  });

  bar.start(ctx);

  assert.deepEqual(statusCalls[0], [STATUS_KEY, `${CLOCK} 00:00 · acme`]);
  assert.equal(scheduler.scheduledMs, 500);

  now = 1000 + 90_000;
  scheduler.fire();
  assert.deepEqual(statusCalls.at(-1), [STATUS_KEY, `${CLOCK} 01:30 · acme`]);
});

test("start is a no-op without a UI", () => {
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeCtx(false, statusCalls);
  const scheduler = makeFakeScheduler();

  const bar = createStatusBar({
    resolveRunClient: () => "acme",
    resolveIdleClient: () => undefined,
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval,
  });

  bar.start(ctx);

  assert.equal(statusCalls.length, 0);
  assert.equal(scheduler.scheduledMs, undefined);
});

test("a second start call while already running does not reset the elapsed clock or schedule another timer", () => {
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeCtx(true, statusCalls);
  let scheduleCount = 0;

  const bar = createStatusBar({
    resolveRunClient: () => undefined,
    resolveIdleClient: () => undefined,
    setInterval: (handler, ms) => {
      scheduleCount += 1;
      return {} as NodeJS.Timeout;
    },
    clearInterval: () => {},
  });

  bar.start(ctx);
  bar.start(ctx);

  assert.equal(scheduleCount, 1);
  assert.equal(statusCalls.length, 1);
});

test("stop clears the timer and falls back to the idle status", () => {
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeCtx(true, statusCalls);
  const scheduler = makeFakeScheduler();

  const bar = createStatusBar({
    resolveRunClient: () => "acme",
    resolveIdleClient: () => "acme",
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval,
  });

  bar.start(ctx);
  bar.stop(ctx);

  assert.equal(scheduler.cancelledCount, 1);
  assert.deepEqual(statusCalls.at(-1), [STATUS_KEY, `${CLIENT} acme`]);
});

test("showIdle shows the client emoji when one resolves, and clears the status otherwise", () => {
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeCtx(true, statusCalls);

  const withClient = createStatusBar({ resolveRunClient: () => undefined, resolveIdleClient: () => "acme" });
  withClient.showIdle(ctx);
  assert.deepEqual(statusCalls.at(-1), [STATUS_KEY, `${CLIENT} acme`]);

  const withoutClient = createStatusBar({ resolveRunClient: () => undefined, resolveIdleClient: () => undefined });
  withoutClient.showIdle(ctx);
  assert.deepEqual(statusCalls.at(-1), [STATUS_KEY, undefined]);
});

test("showIdle is a no-op without a UI", () => {
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = makeCtx(false, statusCalls);
  const bar = createStatusBar({ resolveRunClient: () => undefined, resolveIdleClient: () => "acme" });

  bar.showIdle(ctx);

  assert.equal(statusCalls.length, 0);
});
