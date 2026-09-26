import { readFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CachedCatalog, JsonlWorkLog, PocketBaseClient, PocketBaseSink, SyncStateStore,
  computeSyncStatus, createPocketBaseCatalogFetcher, resolveHubCredentials,
  runSync, safeHomeDir,
} from "kankaku/hub";
import { resolveKankakuDir } from "./paths.ts";
import type { CliResult } from "./cli-core.ts";

export interface SyncCliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => number;
  homeDir?: () => string;
  hostname?: () => string;
  fetch?: typeof fetch;
}

const usage = "usage: node src/cli.ts sync [all|status]\n";

function windowHours(env: NodeJS.ProcessEnv): number {
  const value = Number(env.KANKAKU_SYNC_WINDOW_HOURS);
  return env.KANKAKU_SYNC_WINDOW_HOURS && Number.isFinite(value) && value > 0 ? value : 24;
}

function promptMode(env: NodeJS.ProcessEnv): "none" | "truncated" | "full" {
  const value = env.KANKAKU_SYNC_PROMPT;
  return value === "truncated" || value === "full" ? value : "none";
}

function packageVersion(): string {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

export async function runSyncCli(args: string[], deps: SyncCliDeps): Promise<CliResult> {
  if (args.length > 1 || (args[0] !== undefined && args[0] !== "all" && args[0] !== "status")) {
    return { stdout: "", stderr: usage, exitCode: 1 };
  }
  try {
    const homeDir = deps.homeDir ?? (() => deps.env.HOME || homedir());
    const hub = resolveHubCredentials({ env: deps.env, homeDir });
    const dir = resolveKankakuDir(deps.env.KANKAKU_DIR ?? ".kankaku", deps.cwd);
    const log = new JsonlWorkLog(dir);
    const stateStore = new SyncStateStore({ dir, pid: process.pid, now: deps.now });
    const target = hub.credentials?.url ?? stateStore.read()?.target ?? "";
    const hours = windowHours(deps.env);

    if (args[0] === "status") {
      const { state, pending, staleOutsideWindow } = computeSyncStatus(log, stateStore, target, hours);
      const lines = [
        `hub: ${hub.credentials ? "configured" : "unconfigured"}`,
        `pending: ${pending}`,
        `staleOutsideWindow: ${staleOutsideWindow}`,
        `syncedThrough: ${state?.syncedThrough ?? "none"}`,
      ];
      if (state?.lastError) lines.push(`last error: ${state.lastError.message} (${state.lastError.at})`);
      if (hub.invalidReason) lines.push(`hub URL: ${hub.invalidReason}`);
      return { stdout: lines.join("\n") + "\n", exitCode: 0 };
    }

    if (hub.invalidReason) return { stdout: "", stderr: `kankaku sync: invalid hub URL: ${hub.invalidReason}\n`, exitCode: 1 };
    if (!hub.credentials) return { stdout: "", stderr: "kankaku sync: hub credentials are not configured (KANKAKU_PB_URL, KANKAKU_PB_EMAIL, KANKAKU_PB_PASSWORD).\n", exitCode: 1 };

    const credentials = hub.credentials;
    const client = new PocketBaseClient({ ...credentials, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    const catalog = new CachedCatalog({
      filePath: join(safeHomeDir(homeDir) ?? tmpdir(), ".kankaku", "catalog.json"),
      url: credentials.url,
      clock: { now: deps.now },
      fetchCatalog: createPocketBaseCatalogFetcher(client),
    });
    // Refresh before resolving assignments; on an offline hub the cached snapshot remains usable.
    await catalog.refresh();
    const snapshot = catalog.read();
    const sink = new PocketBaseSink({
      client, clients: snapshot?.clients ?? [], projects: snapshot?.projects ?? [],
      machine: deps.env.KANKAKU_MACHINE || (deps.hostname ?? hostname)(),
      promptMode: promptMode(deps.env), syncRecords: deps.env.KANKAKU_SYNC_RECORDS !== "0",
      agent: "claude-code", plugin: "kankaku-claude", pluginVersion: packageVersion(),
    });
    const summary = await runSync({
      log, sink, stateStore, clock: { now: deps.now }, target: credentials.url, windowHours: hours,
    }, { full: args[0] === "all" });
    const stdout = `uploaded: ${summary.uploaded}, updated: ${summary.updated}, skipped: ${summary.skipped}, failed: ${summary.failed.length}\n`;
    if (summary.locked) return { stdout, stderr: "kankaku sync: another sync is running.\n", exitCode: 1 };
    if (summary.error || summary.failed.length) {
      const reasons = [summary.error, ...summary.failed.map((f) => `${f.id}: ${f.reason}`)].filter(Boolean);
      return { stdout, stderr: `kankaku sync: ${reasons.join("; ")}\n`, exitCode: 1 };
    }
    return { stdout, exitCode: 0 };
  } catch (error) {
    return { stdout: "", stderr: `kankaku sync: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
  }
}
