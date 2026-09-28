/**
 * Detached process control for the local hub's PocketBase server: start,
 * pid tracking, liveness, stop (SIGTERM with a bounded wait, SIGKILL as a
 * last resort) and health polling.
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export interface StartDetachedDeps {
  logFile: string;
  pidFile: string;
}

/**
 * Spawns `binary args` detached (survives the caller exiting), appending
 * its combined stdout/stderr to `logFile`, and writes its pid to
 * `pidFile`. Returns the pid.
 */
export function startDetached(binary: string, args: string[], deps: StartDetachedDeps): number {
  const fd = openSync(deps.logFile, "a");
  const child = spawn(binary, args, { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  const pid = child.pid ?? -1;
  writeFileSync(deps.pidFile, String(pid));
  return pid;
}

/** Reads the pid written by `startDetached`, or `undefined` when `pidFile` is missing or holds no valid positive integer. */
export function readPid(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  const raw = readFileSync(pidFile, "utf8").trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** `true` when a process with `pid` is reachable. An `EPERM` (a different owner, still on this machine) counts as alive; `ESRCH` (no such process) does not. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface StopProcessDeps {
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

export type StopResult = "stopped" | "not-running" | "killed";

const POLL_INTERVAL_MS = 100;
const POST_KILL_POLL_ATTEMPTS = 10;

/**
 * Reads the pid from `pidFile`. If no live process is found, removes a
 * stale pid file (if any) and returns `"not-running"`. Otherwise sends
 * SIGTERM and polls `isAlive` every 100ms up to `deps.timeoutMs`; if the
 * process is still alive at the deadline, sends SIGKILL. Always removes
 * `pidFile` before returning.
 */
export async function stopProcess(pidFile: string, deps: StopProcessDeps): Promise<StopResult> {
  const pid = readPid(pidFile);
  if (pid === undefined || !isAlive(pid)) {
    if (existsSync(pidFile)) unlinkSync(pidFile);
    return "not-running";
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process exited between the isAlive check and here.
    if (existsSync(pidFile)) unlinkSync(pidFile);
    return "not-running";
  }

  let elapsedMs = 0;
  let killedForcibly = false;
  while (isAlive(pid)) {
    if (elapsedMs >= deps.timeoutMs) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      killedForcibly = true;
      break;
    }
    await deps.sleep(POLL_INTERVAL_MS);
    elapsedMs += POLL_INTERVAL_MS;
  }

  if (killedForcibly) {
    for (let attempt = 0; isAlive(pid) && attempt < POST_KILL_POLL_ATTEMPTS; attempt++) {
      await deps.sleep(POLL_INTERVAL_MS);
    }
  }

  if (existsSync(pidFile)) unlinkSync(pidFile);
  return killedForcibly ? "killed" : "stopped";
}

export interface WaitForHealthDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  /**
   * Optional: consulted only after a failed/non-ok fetch attempt. When
   * provided and it reports the process is no longer alive, `waitForHealth`
   * stops immediately instead of waiting out `timeoutMs` — the process
   * exiting (e.g. a port bind failure) means it will never become healthy.
   */
  isAlive?: () => boolean;
}

const HEALTH_POLL_INTERVAL_MS = 500;

/**
 * Polls `GET url` every 500ms until it responds ok, `deps.timeoutMs`
 * elapses, or (when `deps.isAlive` is given) the process dies. Returns
 * whether it became healthy. Never throws.
 */
export async function waitForHealth(url: string, deps: WaitForHealthDeps): Promise<boolean> {
  let elapsedMs = 0;
  for (;;) {
    try {
      const response = await deps.fetch(url);
      if (response.ok) return true;
    } catch {
      // Not up yet; keep polling until the deadline.
    }
    if (deps.isAlive && !deps.isAlive()) return false;
    if (elapsedMs >= deps.timeoutMs) return false;
    await deps.sleep(HEALTH_POLL_INTERVAL_MS);
    elapsedMs += HEALTH_POLL_INTERVAL_MS;
  }
}
