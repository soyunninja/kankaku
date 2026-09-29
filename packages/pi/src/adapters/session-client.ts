import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveClient, resolveClientSource } from "../domain/client-label.ts";
import type { ClientSourceName, ClientSources } from "../domain/client-label.ts";
import type { WorkRole } from "../domain/work-record.ts";

/** Persisted as a `kankaku-client` custom session entry so the session-level client survives a reload. */
export interface KankakuClientEntryData {
  client: string | undefined;
}

export const CLIENT_ENTRY_TYPE = "kankaku-client";

export interface SessionClientDeps {
  role: WorkRole;
  /** Default billing client for this project, from `KANKAKU_CLIENT` (config.ts). See `domain/client-label.ts`. */
  envClient?: string;
  /**
   * Lazily reads the project's default billing client from
   * `<kankaku dir>/config.json`. Injected from `extension.ts` so this
   * adapter stays free of filesystem code.
   */
  resolveProjectClient?: () => string | undefined;
}

export interface SessionClient {
  /** Restore the session-level client from the last `kankaku-client` custom entry; call on `session_start`. */
  restore(ctx: ExtensionContext): void;
  /** Set (or clear with `undefined`) the session client and persist it as a durable session entry. */
  set(pi: ExtensionAPI, client: string | undefined): void;
  /** Current client sources (session > env > project), reading the project client fresh unless `project` is given. */
  sources(project?: string | undefined): ClientSources;
  /** The effective client from {@link sources}, regardless of role. */
  effectiveClient(): string | undefined;
  /** Which source produced {@link effectiveClient}. */
  effectiveSource(): ClientSourceName | undefined;
  /** Role-gated client for the in-progress run (`undefined` for a subagent); caches the project client for the run. */
  runClient(): string | undefined;
  /** Role-gated client to show while idle, reusing the run's cached project client when still held. */
  idleClient(): string | undefined;
  /** Drop the per-run cached project client; call when a run settles or the session shuts down. */
  endRun(): void;
}

/**
 * Owns the session-level billing client override (`/kankaku client <name>`),
 * its restore/persist round-trip through session entries, and client-source
 * resolution for both the in-progress run and the idle status line. See
 * README "Billing labels" and `domain/client-label.ts#resolveClient`.
 */
export function createSessionClient(deps: SessionClientDeps): SessionClient {
  /** Session-level client override, set with `/kankaku client <name>` and restored on `session_start`. Highest precedence. */
  let sessionClient: string | undefined;
  /** Project client read once per run (first record build) so checkpoints do not hit the filesystem repeatedly. */
  let runProjectClient: { value: string | undefined } | undefined;

  function sources(project: string | undefined = deps.resolveProjectClient?.()): ClientSources {
    return {
      session: sessionClient,
      env: deps.envClient,
      project,
    };
  }

  function runSources(): ClientSources {
    if (!runProjectClient) {
      runProjectClient = { value: deps.resolveProjectClient?.() };
    }
    return sources(runProjectClient.value);
  }

  /**
   * Scan the session's entries for the last `kankaku-client` custom entry
   * and restore the client it recorded (`undefined` when that entry cleared
   * the label, or when no such entry exists yet).
   */
  function restore(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as { type: string; customType?: string; data?: unknown };
      if (entry.type === "custom" && entry.customType === CLIENT_ENTRY_TYPE) {
        const data = entry.data as KankakuClientEntryData | undefined;
        sessionClient = data?.client;
        return;
      }
    }
    sessionClient = undefined;
  }

  function set(pi: ExtensionAPI, client: string | undefined): void {
    sessionClient = client;
    pi.appendEntry<KankakuClientEntryData>(CLIENT_ENTRY_TYPE, { client });
  }

  function effectiveClient(): string | undefined {
    return resolveClient(sources());
  }

  function effectiveSource(): ClientSourceName | undefined {
    return resolveClientSource(sources());
  }

  function runClient(): string | undefined {
    return deps.role === "orchestrator" ? resolveClient(runSources()) : undefined;
  }

  function idleClient(): string | undefined {
    const idleSources = runProjectClient ? sources(runProjectClient.value) : sources();
    return deps.role === "orchestrator" ? resolveClient(idleSources) : undefined;
  }

  function endRun(): void {
    runProjectClient = undefined;
  }

  return { restore, set, sources, effectiveClient, effectiveSource, runClient, idleClient, endRun };
}
