import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDetached, readPid, isAlive, stopProcess, waitForHealth } from "../src/adapters/hub-manager/process.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-hub-process-"));
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("startDetached: spawns the process, writes its pid, and readPid reads it back", async () => {
  const dir = makeDir();
  try {
    const logFile = join(dir, "hub.log");
    const pidFile = join(dir, "pid");
    const pid = startDetached(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { logFile, pidFile });

    assert.equal(typeof pid, "number");
    assert.ok(pid > 0);
    assert.equal(readPid(pidFile), pid);
    assert.equal(existsSync(logFile), true);
    assert.equal(isAlive(pid), true);

    process.kill(pid, "SIGKILL");
    await realSleep(100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPid: undefined when the pid file does not exist", () => {
  assert.equal(readPid("/no/such/pid/file"), undefined);
});

test("readPid: undefined when the pid file holds garbage", () => {
  const dir = makeDir();
  try {
    const pidFile = join(dir, "pid");
    writeFileSync(pidFile, "not-a-pid");
    assert.equal(readPid(pidFile), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isAlive: false for a pid that is very unlikely to exist", () => {
  assert.equal(isAlive(999999), false);
});

test("stopProcess: not-running when no pid file exists", async () => {
  const dir = makeDir();
  try {
    const result = await stopProcess(join(dir, "pid"), { timeoutMs: 1000, sleep: realSleep });
    assert.equal(result, "not-running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopProcess: stops a real process with SIGTERM and removes the pid file", async () => {
  const dir = makeDir();
  try {
    const logFile = join(dir, "hub.log");
    const pidFile = join(dir, "pid");
    // This process ignores nothing special; SIGTERM terminates a plain node -e process.
    startDetached(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { logFile, pidFile });

    const result = await stopProcess(pidFile, { timeoutMs: 5000, sleep: realSleep });
    assert.equal(result, "stopped");
    assert.equal(existsSync(pidFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopProcess: force-kills a process that ignores SIGTERM once the timeout elapses", async () => {
  const dir = makeDir();
  try {
    const logFile = join(dir, "hub.log");
    const pidFile = join(dir, "pid");
    startDetached(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { logFile, pidFile });
    await realSleep(200); // let the SIGTERM handler register

    const result = await stopProcess(pidFile, { timeoutMs: 500, sleep: realSleep });
    assert.equal(result, "killed");
    assert.equal(existsSync(pidFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForHealth: true once fetch responds ok", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response(null, { status: calls >= 3 ? 200 : 503 });
  }) as typeof fetch;
  const sleeps: number[] = [];
  const healthy = await waitForHealth("http://127.0.0.1:8090/api/health", {
    fetch: fakeFetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    timeoutMs: 10000,
  });
  assert.equal(healthy, true);
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
});

test("waitForHealth: false once the timeout elapses", async () => {
  const fakeFetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
  let elapsed = 0;
  const healthy = await waitForHealth("http://127.0.0.1:8090/api/health", {
    fetch: fakeFetch,
    sleep: async (ms: number) => {
      elapsed += ms;
    },
    timeoutMs: 1000,
  });
  assert.equal(healthy, false);
});

test("waitForHealth: false when fetch keeps rejecting (server not up yet)", async () => {
  const fakeFetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const healthy = await waitForHealth("http://127.0.0.1:8090/api/health", {
    fetch: fakeFetch,
    sleep: async () => {},
    timeoutMs: 500,
  });
  assert.equal(healthy, false);
});

test("waitForHealth: a fetch that resolves ok on the very first attempt returns true without ever consulting isAlive", async () => {
  const fakeFetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  const healthy = await waitForHealth("http://127.0.0.1:8090/api/health", {
    fetch: fakeFetch,
    sleep: async () => {},
    timeoutMs: 10000,
    isAlive: () => {
      throw new Error("isAlive should not be consulted once fetch already succeeded");
    },
  });
  assert.equal(healthy, true);
});

test("waitForHealth: stops immediately once isAlive reports the process died, without waiting out the timeout", async () => {
  const fakeFetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const healthy = await waitForHealth("http://127.0.0.1:8090/api/health", {
    fetch: fakeFetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    timeoutMs: 10000, // large on purpose: proves the early exit, not the timeout, ended the wait
    isAlive: () => false,
  });
  assert.equal(healthy, false);
  assert.equal(sleeps.length, 0); // returned on the very first failed attempt, never slept
});

test("waitForHealth: keeps polling while isAlive reports the process alive, then stops once it dies", async () => {
  const fakeFetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  let aliveChecks = 0;
  const healthy = await waitForHealth("http://127.0.0.1:8090/api/health", {
    fetch: fakeFetch,
    sleep: async () => {},
    timeoutMs: 10000,
    isAlive: () => {
      aliveChecks += 1;
      return aliveChecks < 3;
    },
  });
  assert.equal(healthy, false);
  assert.ok(aliveChecks >= 3);
});
