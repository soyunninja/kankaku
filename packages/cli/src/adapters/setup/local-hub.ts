/**
 * Level-1 local hub install for the setup wizard's "install locally" hub
 * option: finds a `kankaku-hub` checkout, runs its own dev scripts through
 * the injected `ScriptRunner` (never spawning the real hub in tests), and
 * returns the service account `scripts/create-dev-accounts.sh` creates.
 * The service account's email/password are that script's own hardcoded
 * constants (`SERVICE_EMAIL`/`SERVICE_PASSWORD`), read from
 * `kankaku-hub/scripts/create-dev-accounts.sh`, not environment-overridable
 * there — kept identical here so the credentials this writes always match
 * what the script actually created.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptRunner } from "../../ports/script-runner.ts";

const HUB_URL = "http://127.0.0.1:8090";
const SERVICE_EMAIL = "kankaku-sync@kankaku.local";
const SERVICE_PASSWORD = "kankaku-dev-sync";
const DEFAULT_CHECKOUT_DIR = "~/desarrollo/soyun.ninja/kankaku-hub";
/** The real `kankaku-hub` remote (`git -C <repo> remote get-url origin`), in its https form so no SSH key is required for a one-off clone. */
const HUB_CLONE_URL = "https://github.com/soyunninja/kankaku_hub.git";

const HEALTH_POLL_TIMEOUT_MS = 20000;
const HEALTH_POLL_INTERVAL_MS = 500;

/** The first `candidates` entry that looks like a `kankaku-hub` checkout: has `scripts/dev.sh` and `pocketbase/pb_migrations`. */
export function findHubCheckout(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(join(candidate, "scripts", "dev.sh")) && existsSync(join(candidate, "pocketbase", "pb_migrations")));
}

export interface InstallLocalHubDeps {
  runner: ScriptRunner;
  homeDir: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch: typeof fetch;
  /** Monotonic clock (ms), injected so health polling needs no real timers. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface InstallLocalHubResult {
  ok: boolean;
  url: string;
  serviceEmail?: string;
  servicePassword?: string;
  error?: string;
}

async function pollHealth(url: string, deps: InstallLocalHubDeps): Promise<boolean> {
  const deadline = deps.now() + HEALTH_POLL_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await deps.fetch(url);
      if (response.ok) return true;
    } catch {
      // Not up yet; keep polling until the deadline.
    }
    if (deps.now() >= deadline) return false;
    await deps.sleep(HEALTH_POLL_INTERVAL_MS);
  }
}

/**
 * Installs the local hub from `checkout`: downloads PocketBase (skipped
 * when `pocketbase/bin/pocketbase` already exists), starts `scripts/dev.sh`
 * detached (pid at `~/.kankaku/hub/pid`, log at `~/.kankaku/hub/dev.log`),
 * polls `<HUB_URL>/api/health` for up to ~20s, then runs
 * `scripts/create-dev-accounts.sh`. Returns the local hub's URL and service
 * account on success, or `ok: false` with an `error` at the first failing
 * step — never throws.
 */
export async function installLocalHub(checkout: string, deps: InstallLocalHubDeps): Promise<InstallLocalHubResult> {
  const pocketbaseBinary = join(checkout, "pocketbase", "bin", "pocketbase");
  if (!existsSync(pocketbaseBinary)) {
    const download = await deps.runner.run(join(checkout, "scripts", "pb-download.sh"), [], { cwd: checkout });
    if (download.code !== 0) {
      return { ok: false, url: HUB_URL, error: `pb-download.sh failed: ${download.stderr || download.stdout || `exit code ${download.code}`}` };
    }
  }

  const hubDir = join(deps.homeDir, ".kankaku", "hub");
  mkdirSync(hubDir, { recursive: true });
  const logFile = join(hubDir, "dev.log");
  const { pid } = deps.runner.spawnDetached(join(checkout, "scripts", "dev.sh"), [], { cwd: checkout, logFile });
  writeFileSync(join(hubDir, "pid"), String(pid));

  const healthy = await pollHealth(`${HUB_URL}/api/health`, deps);
  if (!healthy) {
    return { ok: false, url: HUB_URL, error: "the local hub did not become healthy within 20s" };
  }

  const accounts = await deps.runner.run(join(checkout, "scripts", "create-dev-accounts.sh"), [], { cwd: checkout });
  if (accounts.code !== 0) {
    return { ok: false, url: HUB_URL, error: `create-dev-accounts.sh failed: ${accounts.stderr || accounts.stdout || `exit code ${accounts.code}`}` };
  }

  return { ok: true, url: HUB_URL, serviceEmail: SERVICE_EMAIL, servicePassword: SERVICE_PASSWORD };
}

/**
 * The exact command lines to show when no `kankaku-hub` checkout was
 * found: clone it (unless `checkout` names one already on disk), then run
 * its three dev scripts in order.
 */
export function manualCommands(checkout?: string): string[] {
  const dir = checkout ?? DEFAULT_CHECKOUT_DIR;
  const lines: string[] = [];
  if (!checkout) lines.push(`git clone ${HUB_CLONE_URL} ${dir}`);
  lines.push(`cd ${dir}`, "scripts/pb-download.sh", "scripts/dev.sh &", "scripts/create-dev-accounts.sh");
  return lines;
}
