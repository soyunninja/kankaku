/**
 * Orchestrates the local hub's full lifecycle: install (idempotent),
 * start, stop, status and upgrade — composing the pure
 * `domain/local-hub-model.ts` with the other `hub-manager/*` adapters
 * (`package.ts`, `download.ts`, `process.ts`, `accounts.ts`) and
 * `adapters/setup/hub.ts#writeHubCredentials`. Every piece of I/O is
 * injected (`HubManagerDeps`) so tests never touch the network, spawn a
 * real PocketBase, or run a real script.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assetKeyFor,
  classifyStatus,
  generatePassword,
  hubLayout,
  parseHubConfig,
  serveArgs,
} from "../../domain/local-hub-model.ts";
import type { HubAccounts, HubConfig, HubStatus } from "../../domain/local-hub-model.ts";
import { locateHubPackage } from "./package.ts";
import type { LocateHubPackageResult } from "./package.ts";
import { downloadPocketBase } from "./download.ts";
import { isAlive, readPid, stopProcess, waitForHealth } from "./process.ts";
import { createUser, upsertSuperuser } from "./accounts.ts";
import { writeHubCredentials } from "../setup/hub.ts";
import type { ScriptRunner } from "../../ports/script-runner.ts";

const OWNER_DIR_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
/** The PocketBase superuser account this package provisions on first install; distinct from the owner/service application users. */
const SUPERUSER_EMAIL = "admin@kankaku.local";
const SERVICE_EMAIL = "kankaku-sync@kankaku.local";
export const DEFAULT_HUB_PORT = 8090;
const HEALTH_TIMEOUT_MS = 20000;
const STOP_TIMEOUT_MS = 5000;

export interface InstallHubOptions {
  port?: number;
  ownerEmail: string;
  ownerPassword: string;
}

export type HubStepOutcome = "done" | "unchanged" | "error";

export interface HubStepReport {
  step: string;
  outcome: HubStepOutcome;
  detail?: string;
}

export interface HubActionReport {
  ok: boolean;
  steps: HubStepReport[];
  url?: string;
}

export interface HubManagerDeps {
  homeDir: string;
  /** Injectable for tests; the real caller passes the global `fetch`. */
  fetch: typeof fetch;
  /** Runs `pocketbase superuser upsert` offline (see `hub-manager/accounts.ts`). */
  runner: ScriptRunner;
  /** Spawns the PocketBase server detached; the real caller passes `hub-manager/process.ts#startDetached`. */
  startDetached: (binary: string, args: string[], opts: { logFile: string; pidFile: string }) => number;
  sleep: (ms: number) => Promise<void>;
  /** Monotonic-enough wall clock (ms); used only for `hub.json`'s `installedAt`. */
  now: () => number;
  randomBytes: (n: number) => Uint8Array;
  /** Locates the installed `kankaku-hub` package; the real caller passes `hub-manager/package.ts#locateHubPackage`. */
  locatePackage: () => LocateHubPackageResult;
  platform: NodeJS.Platform;
  arch: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readConfigOrUndefined(hubJsonPath: string): HubConfig | undefined {
  if (!existsSync(hubJsonPath)) return undefined;
  try {
    return parseHubConfig(JSON.parse(readFileSync(hubJsonPath, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

/** Fresh-copies `pocketbase/pb_migrations`, `pocketbase/pb_hooks` and `public` from the package into `appDir` — never a symlink, so `npm update` cannot change a running hub. */
function copyAppFiles(packageDir: string, appDir: string): void {
  cpSync(join(packageDir, "pocketbase", "pb_migrations"), join(appDir, "pocketbase", "pb_migrations"), { recursive: true });
  cpSync(join(packageDir, "pocketbase", "pb_hooks"), join(appDir, "pocketbase", "pb_hooks"), { recursive: true });
  cpSync(join(packageDir, "public"), join(appDir, "public"), { recursive: true });
}

function baseUrlFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Installs (or, run again, verifies) the local hub under
 * `~/.kankaku/hub`: locates the `kankaku-hub` package, creates the layout
 * directories (root created 0700, never chmod'd again once it exists —
 * mirrors kankaku's own R2 rule), downloads the PocketBase binary for
 * this platform when missing or out of date (SHA256-verified), copies the
 * package's migrations/hooks/public into `app/<version>/`, writes
 * `hub.json`, and — only the first time, when `accounts.json` doesn't
 * exist yet — provisions the superuser and the owner/service application
 * users, then leaves the server running. Idempotent: re-running with
 * everything already present reports every step `unchanged` and touches
 * neither the process nor the accounts. Never throws; a failing step
 * stops the sequence and is reported as `error`.
 */
export async function installHub(options: InstallHubOptions, deps: HubManagerDeps): Promise<HubActionReport> {
  const port = options.port ?? DEFAULT_HUB_PORT;
  const steps: HubStepReport[] = [];

  let located: LocateHubPackageResult;
  try {
    located = deps.locatePackage();
  } catch (error) {
    return { ok: false, steps: [{ step: "locate kankaku-hub package", outcome: "error", detail: message(error) }] };
  }
  const manifest = located.manifest;
  const layout = hubLayout(deps.homeDir);

  const rootExisted = existsSync(layout.root);
  if (!rootExisted) mkdirSync(layout.root, { recursive: true, mode: OWNER_DIR_MODE });
  mkdirSync(layout.bin, { recursive: true });
  mkdirSync(layout.pbData, { recursive: true });
  steps.push({ step: "create ~/.kankaku/hub", outcome: rootExisted ? "unchanged" : "done" });

  const existingConfig = readConfigOrUndefined(layout.hubJson);
  const needsBinary = !existsSync(layout.binary) || existingConfig?.pocketbaseVersion !== manifest.pocketbase.version;
  if (needsBinary) {
    try {
      const asset = manifest.pocketbase.assets[assetKeyFor(deps.platform, deps.arch)];
      await downloadPocketBase(asset, layout.binary, { fetch: deps.fetch });
      steps.push({ step: "download pocketbase", outcome: "done", detail: manifest.pocketbase.version });
    } catch (error) {
      steps.push({ step: "download pocketbase", outcome: "error", detail: message(error) });
      return { ok: false, steps };
    }
  } else {
    steps.push({ step: "download pocketbase", outcome: "unchanged" });
  }

  const appDir = layout.appDir(manifest.version);
  const appDirExisted = existsSync(appDir);
  if (!appDirExisted) {
    try {
      copyAppFiles(located.dir, appDir);
    } catch (error) {
      steps.push({ step: "install app files", outcome: "error", detail: message(error) });
      return { ok: false, steps };
    }
  }
  writeFileSync(layout.currentFile, manifest.version);
  steps.push({ step: "install app files", outcome: appDirExisted ? "unchanged" : "done", detail: manifest.version });

  const newConfig: HubConfig = {
    port,
    appVersion: manifest.version,
    pocketbaseVersion: manifest.pocketbase.version,
    installedAt: existingConfig?.installedAt ?? new Date(deps.now()).toISOString(),
  };
  const hubJsonChanged =
    !existingConfig || existingConfig.port !== newConfig.port || existingConfig.appVersion !== newConfig.appVersion || existingConfig.pocketbaseVersion !== newConfig.pocketbaseVersion;
  if (hubJsonChanged) writeFileSync(layout.hubJson, JSON.stringify(newConfig, null, 2));
  steps.push({ step: "write hub.json", outcome: hubJsonChanged ? "done" : "unchanged" });

  const accountsExist = existsSync(layout.accountsJson);
  if (accountsExist) {
    steps.push({ step: "provision accounts", outcome: "unchanged" });
    return { ok: true, steps, url: baseUrlFor(port) };
  }

  try {
    const superuserPassword = generatePassword(deps.randomBytes);
    await upsertSuperuser(layout.binary, layout.pbData, SUPERUSER_EMAIL, superuserPassword, deps.runner);

    deps.startDetached(layout.binary, serveArgs(layout, manifest.version, port), { logFile: layout.logFile, pidFile: layout.pidFile });
    const url = baseUrlFor(port);
    const healthy = await waitForHealth(`${url}/api/health`, { fetch: deps.fetch, sleep: deps.sleep, timeoutMs: HEALTH_TIMEOUT_MS });
    if (!healthy) {
      steps.push({ step: "provision accounts", outcome: "error", detail: "the local hub did not become healthy within 20s" });
      return { ok: false, steps };
    }

    const superuser = { email: SUPERUSER_EMAIL, password: superuserPassword };
    await createUser(url, superuser, { email: options.ownerEmail, password: options.ownerPassword, role: "owner" }, deps.fetch);
    const servicePassword = generatePassword(deps.randomBytes);
    await createUser(url, superuser, { email: SERVICE_EMAIL, password: servicePassword, role: "service" }, deps.fetch);

    const accounts: HubAccounts = { superuserEmail: SUPERUSER_EMAIL, superuserPassword, ownerEmail: options.ownerEmail };
    writeFileSync(layout.accountsJson, JSON.stringify(accounts, null, 2));
    chmodSync(layout.accountsJson, OWNER_FILE_MODE);
    writeHubCredentials(deps.homeDir, { url, email: SERVICE_EMAIL, password: servicePassword });

    steps.push({ step: "provision accounts", outcome: "done" });
    return { ok: true, steps, url };
  } catch (error) {
    steps.push({ step: "provision accounts", outcome: "error", detail: message(error) });
    return { ok: false, steps };
  }
}

/** Starts the installed hub: a no-op (`unchanged`) if already running, otherwise spawns it and waits for health. */
export async function startHub(deps: HubManagerDeps): Promise<HubActionReport> {
  const layout = hubLayout(deps.homeDir);
  const config = readConfigOrUndefined(layout.hubJson);
  if (!config) return { ok: false, steps: [{ step: "start", outcome: "error", detail: "the local hub is not installed" }] };

  const pid = readPid(layout.pidFile);
  if (pid !== undefined && isAlive(pid)) {
    return { ok: true, steps: [{ step: "start", outcome: "unchanged", detail: "already running" }], url: baseUrlFor(config.port) };
  }

  deps.startDetached(layout.binary, serveArgs(layout, config.appVersion, config.port), { logFile: layout.logFile, pidFile: layout.pidFile });
  const url = baseUrlFor(config.port);
  const healthy = await waitForHealth(`${url}/api/health`, { fetch: deps.fetch, sleep: deps.sleep, timeoutMs: HEALTH_TIMEOUT_MS });
  return {
    ok: healthy,
    steps: [{ step: "start", outcome: healthy ? "done" : "error", detail: healthy ? undefined : "did not become healthy within 20s" }],
    url,
  };
}

/** Stops the installed hub via `SIGTERM` (bounded wait, `SIGKILL` as a last resort). A no-op (`unchanged`) when it wasn't running. */
export async function stopHub(deps: Pick<HubManagerDeps, "homeDir" | "sleep">): Promise<HubActionReport> {
  const layout = hubLayout(deps.homeDir);
  const result = await stopProcess(layout.pidFile, { timeoutMs: STOP_TIMEOUT_MS, sleep: deps.sleep });
  return { ok: true, steps: [{ step: "stop", outcome: result === "not-running" ? "unchanged" : "done", detail: result }] };
}

/** Classifies the installed hub's current status (`hubLayout`, pid liveness and, only while a process is alive, one health check). Never throws. */
export async function hubStatus(deps: Pick<HubManagerDeps, "homeDir" | "fetch">): Promise<HubStatus> {
  const layout = hubLayout(deps.homeDir);
  const config = readConfigOrUndefined(layout.hubJson);
  const pid = readPid(layout.pidFile);
  const pidAlive = pid !== undefined && isAlive(pid);

  let health: "ok" | "failed" | "skipped" = "skipped";
  if (pidAlive && config) {
    try {
      const response = await deps.fetch(`${baseUrlFor(config.port)}/api/health`);
      health = response.ok ? "ok" : "failed";
    } catch {
      health = "failed";
    }
  }

  return classifyStatus({ installed: config !== undefined, config, pidAlive, health });
}

/**
 * Upgrades the local hub to the currently installed `kankaku-hub`
 * package's version: copies a fresh `app/<new version>/` (when not
 * already present), downloads a new PocketBase binary only if its
 * version changed, restarts the process, and leaves `pb_data` untouched.
 * A no-op (`unchanged`) when the installed package is already the
 * running version.
 */
export async function upgradeHub(deps: HubManagerDeps): Promise<HubActionReport> {
  const layout = hubLayout(deps.homeDir);
  const config = readConfigOrUndefined(layout.hubJson);
  if (!config) return { ok: false, steps: [{ step: "upgrade", outcome: "error", detail: "the local hub is not installed" }] };

  let located: LocateHubPackageResult;
  try {
    located = deps.locatePackage();
  } catch (error) {
    return { ok: false, steps: [{ step: "locate kankaku-hub package", outcome: "error", detail: message(error) }] };
  }
  const manifest = located.manifest;

  if (manifest.version === config.appVersion && manifest.pocketbase.version === config.pocketbaseVersion) {
    return { ok: true, steps: [{ step: "upgrade", outcome: "unchanged", detail: "already up to date" }], url: baseUrlFor(config.port) };
  }

  const steps: HubStepReport[] = [];
  const appDir = layout.appDir(manifest.version);
  const appDirExisted = existsSync(appDir);
  if (!appDirExisted) {
    try {
      copyAppFiles(located.dir, appDir);
    } catch (error) {
      steps.push({ step: "install app files", outcome: "error", detail: message(error) });
      return { ok: false, steps };
    }
  }
  writeFileSync(layout.currentFile, manifest.version);
  steps.push({ step: "install app files", outcome: appDirExisted ? "unchanged" : "done", detail: manifest.version });

  if (manifest.pocketbase.version !== config.pocketbaseVersion) {
    try {
      const asset = manifest.pocketbase.assets[assetKeyFor(deps.platform, deps.arch)];
      await downloadPocketBase(asset, layout.binary, { fetch: deps.fetch });
      steps.push({ step: "download pocketbase", outcome: "done", detail: manifest.pocketbase.version });
    } catch (error) {
      steps.push({ step: "download pocketbase", outcome: "error", detail: message(error) });
      return { ok: false, steps };
    }
  } else {
    steps.push({ step: "download pocketbase", outcome: "unchanged" });
  }

  const newConfig: HubConfig = { ...config, appVersion: manifest.version, pocketbaseVersion: manifest.pocketbase.version };
  writeFileSync(layout.hubJson, JSON.stringify(newConfig, null, 2));
  steps.push({ step: "write hub.json", outcome: "done" });

  await stopProcess(layout.pidFile, { timeoutMs: STOP_TIMEOUT_MS, sleep: deps.sleep });
  deps.startDetached(layout.binary, serveArgs(layout, newConfig.appVersion, newConfig.port), { logFile: layout.logFile, pidFile: layout.pidFile });
  const url = baseUrlFor(newConfig.port);
  const healthy = await waitForHealth(`${url}/api/health`, { fetch: deps.fetch, sleep: deps.sleep, timeoutMs: HEALTH_TIMEOUT_MS });
  steps.push({ step: "restart", outcome: healthy ? "done" : "error", detail: healthy ? undefined : "did not become healthy within 20s" });

  return { ok: healthy, steps, url };
}

/** The last `n` lines of `hub.log`, oldest first; `[]` when the hub has never logged anything. */
export function hubLogs(n: number, deps: Pick<HubManagerDeps, "homeDir">): string[] {
  const layout = hubLayout(deps.homeDir);
  if (!existsSync(layout.logFile)) return [];
  const content = readFileSync(layout.logFile, "utf8");
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(Math.max(lines.length - n, 0));
}
