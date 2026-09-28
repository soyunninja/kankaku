import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardActionsDeps, loadDashboard } from "../src/cli.tsx";
import type { CliDeps } from "../src/cli.tsx";
import type { HubManagerDeps } from "../src/adapters/hub-manager/install.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-cli-dashboard-home-"));
}

function writeHubJson(home: string, port: number): void {
  mkdirSync(join(home, ".kankaku", "hub"), { recursive: true });
  writeFileSync(join(home, ".kankaku", "hub", "hub.json"), JSON.stringify({ port, appVersion: "0.2.0", pocketbaseVersion: "0.40.4", installedAt: "2026-09-28T00:00:00.000Z" }));
}

function writeCredentials(home: string, url: string): void {
  mkdirSync(join(home, ".kankaku"), { recursive: true });
  writeFileSync(join(home, ".kankaku", "credentials.json"), JSON.stringify({ url, email: "kankaku-sync@kankaku.local", password: "s3cret" }));
}

function baseDeps(home: string, overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    homeDir: home,
    cwd: join(home, "project"),
    env: {},
    fetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
    stdout: () => {},
    stderr: () => {},
    exit: () => {},
    renderApp: () => {
      throw new Error("should not render the TUI");
    },
    ...overrides,
  };
}

test("loadDashboard: hub.localHub is undefined when there is no ~/.kankaku/hub/hub.json at all", () => {
  const home = makeHome();
  try {
    writeCredentials(home, "https://hub.example.com");
    const model = loadDashboard([], baseDeps(home));
    assert.equal(model.hub.status === "ready" && "localHub" in model.hub, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadDashboard: hub.localHub is undefined when credentials point elsewhere than the installed local hub's port", () => {
  const home = makeHome();
  try {
    writeHubJson(home, 8090);
    writeCredentials(home, "https://hub.example.com");
    const model = loadDashboard([], baseDeps(home));
    assert.equal(model.hub.status === "ready" && "localHub" in model.hub, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadDashboard: hub.localHub is 'stopped' when hub.json matches but no process is alive", () => {
  const home = makeHome();
  try {
    writeHubJson(home, 8090);
    writeCredentials(home, "http://127.0.0.1:8090");
    const model = loadDashboard([], baseDeps(home));
    assert.equal(model.hub.status === "ready" && model.hub.localHub, "stopped");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadDashboard: hub.localHub is 'running' when hub.json matches and the pid is alive", () => {
  const home = makeHome();
  try {
    writeHubJson(home, 8090);
    writeCredentials(home, "http://127.0.0.1:8090");
    writeFileSync(join(home, ".kankaku", "hub", "pid"), String(process.pid)); // this test process is definitely alive
    const model = loadDashboard([], baseDeps(home));
    assert.equal(model.hub.status === "ready" && model.hub.localHub, "running");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dashboardActionsDeps: localHub is undefined for a remote hub", () => {
  const home = makeHome();
  try {
    writeCredentials(home, "https://hub.example.com");
    const actions = dashboardActionsDeps(baseDeps(home), []);
    assert.equal(actions.localHub, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dashboardActionsDeps: localHub.toggle starts a stopped local hub via the injected hub manager", async () => {
  const home = makeHome();
  try {
    writeHubJson(home, 8090);
    writeCredentials(home, "http://127.0.0.1:8090");

    const startCalls: { binary: string; args: string[] }[] = [];
    let listening = false; // flips once "spawned" below, so the pre-spawn port-availability check sees the port as free
    const hubManager: Partial<HubManagerDeps> = {
      fetch: (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/health")) {
          if (!listening) throw new Error("ECONNREFUSED");
          return new Response(null, { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch,
      startDetached: (binary, args, opts) => {
        startCalls.push({ binary, args });
        writeFileSync(opts.pidFile, String(process.pid));
        listening = true;
        return process.pid;
      },
      sleep: async () => {},
    };
    const actions = dashboardActionsDeps(baseDeps(home, { hubManager }), []);
    assert.ok(actions.localHub);
    const message = await actions.localHub!.toggle();
    assert.equal(message, "started the local hub");
    assert.equal(startCalls.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dashboardActionsDeps: localHub.toggle stops a running local hub via the injected hub manager", async () => {
  const home = makeHome();
  try {
    writeHubJson(home, 8090);
    writeCredentials(home, "http://127.0.0.1:8090");

    // A real, short-lived sleeper child stands in for the hub process, so `stopHub`'s real SIGTERM
    // targets an actual process instead of accidentally hitting this test runner's own pid.
    const { startDetached } = await import("../src/adapters/hub-manager/process.ts");
    const childPid = startDetached(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], {
      logFile: join(home, ".kankaku", "hub", "hub.log"),
      pidFile: join(home, ".kankaku", "hub", "pid"),
    });

    const actions = dashboardActionsDeps(baseDeps(home), []);
    assert.ok(actions.localHub);
    const message = await actions.localHub!.toggle();
    assert.equal(message, "stopped the local hub");

    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // Already stopped by the toggle above.
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
