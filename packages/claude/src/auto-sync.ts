import type { SyncTrigger } from "kankaku/hub";
import type { SyncCliDeps } from "./sync-cli.ts";

export interface AutoSyncDeps extends SyncCliDeps {
  stderr: (message: string) => void;
}

/** Best-effort heavy-hook sync; credential/transport errors never escape into record handling. */
export async function autoSync(trigger: SyncTrigger, deps: AutoSyncDeps): Promise<void> {
  if (deps.env.KANKAKU_SYNC_AUTO === "0") return;
  try {
    const { resolveHubCredentials } = await import("kankaku/hub");
    const { homedir } = await import("node:os");
    const hub = resolveHubCredentials({ env: deps.env, homeDir: deps.homeDir ?? (() => deps.env.HOME || homedir()) });
    if (!hub.credentials || hub.invalidReason) return;
    const { syncConfigured } = await import("./sync-cli.ts");
    // One deadline across catalog and upload requests; the public client also
    // imposes its own per-request timeout. No timer persists after the hook.
    const deadline = AbortSignal.timeout(8_000);
    const doFetch = deps.fetch ?? fetch;
    const boundedFetch: typeof fetch = (input, init) => doFetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    });
    const result = await syncConfigured({ ...deps, fetch: boundedFetch }, hub.credentials, { trigger });
    if (result.error || result.failed.length) {
      deps.stderr(`kankaku auto-sync: ${result.error ?? result.failed.map((f) => f.reason).join("; ")}`);
    }
  } catch (error) {
    deps.stderr(`kankaku auto-sync: ${error instanceof Error ? error.message : String(error)}`);
  }
}
