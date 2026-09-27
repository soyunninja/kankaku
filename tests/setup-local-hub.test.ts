import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHubCheckout, installLocalHub, manualCommands } from "../src/adapters/setup/local-hub.ts";
import type { ScriptRunner, ScriptRunResult } from "../src/ports/script-runner.ts";

function makeDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `kankaku-tui-${prefix}-`));
}

function makeCheckout(dir: string, options: { pocketbaseBinary?: boolean } = {}): void {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "pocketbase", "pb_migrations"), { recursive: true });
  writeFileSync(join(dir, "scripts", "dev.sh"), "#!/usr/bin/env bash\n");
  if (options.pocketbaseBinary) {
    mkdirSync(join(dir, "pocketbase", "bin"), { recursive: true });
    writeFileSync(join(dir, "pocketbase", "bin", "pocketbase"), "#!/usr/bin/env bash\n");
  }
}

interface RunCall {
  cmd: string;
  args: string[];
  cwd: string;
}

function fakeRunner(runResult: (call: RunCall) => ScriptRunResult): { runner: ScriptRunner; runCalls: RunCall[]; detachedCalls: { cmd: string; args: string[]; cwd: string; logFile: string }[] } {
  const runCalls: RunCall[] = [];
  const detachedCalls: { cmd: string; args: string[]; cwd: string; logFile: string }[] = [];
  const runner: ScriptRunner = {
    async run(cmd, args, opts) {
      const call = { cmd, args, cwd: opts.cwd };
      runCalls.push(call);
      return runResult(call);
    },
    spawnDetached(cmd, args, opts) {
      detachedCalls.push({ cmd, args, cwd: opts.cwd, logFile: opts.logFile });
      return { pid: 4242 };
    },
  };
  return { runner, runCalls, detachedCalls };
}

function ok(): ScriptRunResult {
  return { code: 0, stdout: "", stderr: "" };
}

function okFetch(): typeof fetch {
  return (async () => new Response(null, { status: 200 })) as typeof fetch;
}

function healthyAfter(callsUntilHealthy: number): typeof fetch {
  let calls = 0;
  return (async () => {
    calls += 1;
    return new Response(null, { status: calls >= callsUntilHealthy ? 200 : 503 });
  }) as typeof fetch;
}

function neverHealthyFetch(): typeof fetch {
  return (async () => new Response(null, { status: 503 })) as typeof fetch;
}

function testDeps(overrides: Partial<Parameters<typeof installLocalHub>[1]> = {}) {
  let clock = 0;
  const { runner } = fakeRunner(ok);
  return {
    runner,
    homeDir: makeDir("home"),
    fetch: okFetch(),
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    ...overrides,
  };
}

// ---- findHubCheckout ----

test("findHubCheckout: finds a candidate with scripts/dev.sh and pocketbase/pb_migrations", () => {
  const dir = makeDir("checkout");
  try {
    makeCheckout(dir);
    assert.equal(findHubCheckout([dir]), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findHubCheckout: skips a candidate missing scripts/dev.sh", () => {
  const dir = makeDir("checkout");
  try {
    mkdirSync(join(dir, "pocketbase", "pb_migrations"), { recursive: true });
    assert.equal(findHubCheckout([dir]), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findHubCheckout: skips a candidate missing pocketbase/pb_migrations", () => {
  const dir = makeDir("checkout");
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "dev.sh"), "");
    assert.equal(findHubCheckout([dir]), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findHubCheckout: returns the first matching candidate", () => {
  const missing = makeDir("checkout-a");
  const present = makeDir("checkout-b");
  try {
    makeCheckout(present);
    assert.equal(findHubCheckout([missing, present]), present);
  } finally {
    rmSync(missing, { recursive: true, force: true });
    rmSync(present, { recursive: true, force: true });
  }
});

test("findHubCheckout: returns undefined for an empty candidate list", () => {
  assert.equal(findHubCheckout([]), undefined);
});

// ---- installLocalHub ----

test("installLocalHub: skips pb-download.sh when the pocketbase binary already exists", async () => {
  const checkout = makeDir("checkout");
  try {
    makeCheckout(checkout, { pocketbaseBinary: true });
    const { runner, runCalls } = fakeRunner(ok);
    const result = await installLocalHub(checkout, testDeps({ runner }));
    assert.equal(result.ok, true);
    assert.equal(runCalls.some((call) => call.cmd.includes("pb-download.sh")), false);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("installLocalHub: runs pb-download.sh when the pocketbase binary is missing", async () => {
  const checkout = makeDir("checkout");
  try {
    makeCheckout(checkout);
    const { runner, runCalls } = fakeRunner(ok);
    await installLocalHub(checkout, testDeps({ runner }));
    assert.equal(runCalls.some((call) => call.cmd.includes("pb-download.sh") && call.cwd === checkout), true);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("installLocalHub: spawns dev.sh detached, writing its pid and pointing its log under ~/.kankaku/hub", async () => {
  const checkout = makeDir("checkout");
  try {
    makeCheckout(checkout, { pocketbaseBinary: true });
    const homeDir = makeDir("home");
    const { runner, detachedCalls } = fakeRunner(ok);
    await installLocalHub(checkout, testDeps({ runner, homeDir }));

    assert.equal(detachedCalls.length, 1);
    assert.equal(detachedCalls[0]?.cmd.includes("dev.sh"), true);
    assert.equal(detachedCalls[0]?.cwd, checkout);
    assert.equal(detachedCalls[0]?.logFile, join(homeDir, ".kankaku", "hub", "dev.log"));

    const pidFile = join(homeDir, ".kankaku", "hub", "pid");
    assert.equal(existsSync(pidFile), true);
    assert.equal(readFileSync(pidFile, "utf8"), "4242");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("installLocalHub: polls health, then runs create-dev-accounts.sh, and returns the service account", async () => {
  const checkout = makeDir("checkout");
  try {
    makeCheckout(checkout, { pocketbaseBinary: true });
    const { runner, runCalls } = fakeRunner(ok);
    const result = await installLocalHub(checkout, testDeps({ runner, fetch: healthyAfter(3) }));

    assert.equal(result.ok, true);
    assert.equal(result.url, "http://127.0.0.1:8090");
    assert.equal(result.serviceEmail, "kankaku-sync@kankaku.local");
    assert.equal(result.servicePassword, "kankaku-dev-sync");
    assert.equal(runCalls.some((call) => call.cmd.includes("create-dev-accounts.sh") && call.cwd === checkout), true);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("installLocalHub: fails when health never comes up within the timeout, without running create-dev-accounts.sh", async () => {
  const checkout = makeDir("checkout");
  try {
    makeCheckout(checkout, { pocketbaseBinary: true });
    const { runner, runCalls } = fakeRunner(ok);
    const result = await installLocalHub(checkout, testDeps({ runner, fetch: neverHealthyFetch() }));

    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
    assert.equal(runCalls.some((call) => call.cmd.includes("create-dev-accounts.sh")), false);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("installLocalHub: fails when pb-download.sh exits non-zero, without spawning dev.sh", async () => {
  const checkout = makeDir("checkout");
  try {
    makeCheckout(checkout);
    const { runner, detachedCalls } = fakeRunner(() => ({ code: 1, stdout: "", stderr: "download failed" }));
    const result = await installLocalHub(checkout, testDeps({ runner }));

    assert.equal(result.ok, false);
    assert.equal(result.error?.includes("download failed"), true);
    assert.equal(detachedCalls.length, 0);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("installLocalHub: fails when create-dev-accounts.sh exits non-zero", async () => {
  const checkout = makeDir("checkout");
  try {
    makeCheckout(checkout, { pocketbaseBinary: true });
    const { runner } = fakeRunner((call) => (call.cmd.includes("create-dev-accounts.sh") ? { code: 1, stdout: "", stderr: "accounts failed" } : ok()));
    const result = await installLocalHub(checkout, testDeps({ runner }));

    assert.equal(result.ok, false);
    assert.equal(result.error?.includes("accounts failed"), true);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

// ---- manualCommands ----

test("manualCommands: includes the real https clone URL and a default checkout dir when none is given", () => {
  const lines = manualCommands();
  const joined = lines.join("\n");
  assert.equal(joined.includes("https://github.com/soyunninja/kankaku_hub.git"), true);
  assert.equal(joined.includes("~/desarrollo/soyun.ninja/kankaku-hub"), true);
  assert.equal(joined.includes("pb-download.sh"), true);
  assert.equal(joined.includes("dev.sh"), true);
  assert.equal(joined.includes("create-dev-accounts.sh"), true);
});

test("manualCommands: uses the given checkout path instead of cloning", () => {
  const lines = manualCommands("/existing/kankaku-hub");
  const joined = lines.join("\n");
  assert.equal(joined.includes("/existing/kankaku-hub"), true);
  assert.equal(joined.includes("git clone"), false);
});
