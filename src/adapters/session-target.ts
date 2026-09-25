import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatWorkTargetLabel, resolveWorkTarget, resolveWorkTargetSource } from "../domain/work-target.ts";
import type { WorkTarget, WorkTargetCandidate, WorkTargetSessionOverride, WorkTargetSourceName } from "../domain/work-target.ts";
import type { WorkRole } from "../domain/work-record.ts";
import type { Catalog, CatalogSnapshot } from "../ports/catalog.ts";
import { pickHubTask, pickTarget } from "./target-picker.ts";

/** Persisted as a `kankaku-target` custom session entry so the session-level target survives a reload. */
export interface KankakuTargetEntryData {
  clientId?: string;
  projectId?: string;
  /** `true` when the user explicitly declined the picker; distinct from "no entry yet". */
  skipped?: boolean;
  /**
   * A hub task picked for this session (`/kankaku task pick`). Session-only:
   * never written to the project's `.kankaku/config.json`, and dropped by
   * any target change (`pick`/`setExplicit`/`clear`/`ensurePicked`'s
   * silent resolution) since those all build a fresh candidate without it.
   */
  hubTaskId?: string;
}

export const TARGET_ENTRY_TYPE = "kankaku-target";

export interface SessionTargetDeps {
  role: WorkRole;
  catalog: Catalog;
  /** Lazily reads `clientId`/`projectId` from `<kankaku dir>/config.json`. */
  resolveProjectConfigIds: () => WorkTargetCandidate | undefined;
  /** Persist `clientId`/`projectId` into `<kankaku dir>/config.json`, merging existing keys. */
  persistProjectConfig: (ids: WorkTargetCandidate) => void;
  /** Current working directory, matched against catalog `repo_paths`. Defaults to `process.cwd()`. */
  cwd?: () => string;
  /**
   * Overall deadline, in ms, for the very first (no-cache) catalog fetch —
   * see {@link getSnapshot}. Bounds auth, pagination and the 401 retry
   * together via an `AbortSignal` composed with each request's own
   * per-request timeout, instead of leaving that awaited path bounded only
   * per-request. Defaults to 5000.
   */
  firstFetchDeadlineMs?: number;
  /**
   * Deadline, in ms, for awaiting an already-in-flight background refresh
   * before showing the picker with the cached snapshot instead — see
   * {@link getSnapshotForPicker}. The refresh itself is never aborted at
   * this deadline; it keeps running, and a later `catalog.read()` call
   * (e.g. the next run) sees its result once it lands. Defaults to 1500.
   */
  pickerRefreshDeadlineMs?: number;
  /** Injectable for tests; defaults to the global timer functions. */
  setTimeout?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
}

const DEFAULT_FIRST_FETCH_DEADLINE_MS = 5000;
const DEFAULT_PICKER_REFRESH_DEADLINE_MS = 1500;

export interface SessionTarget {
  /** Restore the session-level target (or its remembered "skipped" state) from the last `kankaku-target` entry. */
  restore(ctx: ExtensionContext): void;
  /**
   * The `session_start` flow: resolves silently from the project config
   * file or catalog `repo_paths`, or — only when nothing resolves and no
   * session entry (pick or skip) already exists — shows the picker. A
   * no-op unless `role === "orchestrator"` and `ctx.hasUI`.
   */
  ensurePicked(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void>;
  /** Force the picker again, e.g. `/kankaku target pick`. Ignores any existing session override. */
  pick(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void>;
  /** Set the session target directly, bypassing the picker (the legacy `/kankaku client <name>` compatibility path). */
  setExplicit(pi: ExtensionAPI, ids: WorkTargetCandidate): void;
  /** Clear the session-level override; resolution falls back to the project config file / `repo_paths`. */
  clear(pi: ExtensionAPI): void;
  /**
   * `/kankaku task pick`: shows the hub-task picker for the effective
   * project's open/doing tasks and links the pick to the session (never
   * persisted to the project config file). Notifies when there is no
   * effective client/project yet, or the project has no open/doing task.
   * A no-op unless `role === "orchestrator"` and `ctx.hasUI`.
   */
  pickTask(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void>;
  /** `/kankaku task clear`: drops the linked hub task, keeping the rest of the session target. A no-op when none is linked. */
  clearTask(pi: ExtensionAPI): void;
  /** Current effective target (session > project config > repoPaths), regardless of role. */
  effectiveTarget(): WorkTarget | undefined;
  /** Which source produced {@link effectiveTarget}. */
  effectiveSource(): WorkTargetSourceName | undefined;
  /** Role-gated target for the in-progress run (`undefined` for a subagent); caches the project config read for the run. */
  runTarget(): WorkTarget | undefined;
  /** Role-gated target to show while idle, reusing the run's cached project config read when still held. */
  idleTarget(): WorkTarget | undefined;
  /** Drop the per-run cached project config read; call when a run settles or the session shuts down. */
  endRun(): void;
}

function candidateFrom(target: WorkTarget): WorkTargetCandidate {
  return { clientId: target.clientId, ...(target.projectId !== undefined ? { projectId: target.projectId } : {}) };
}

function entryDataFrom(ids: WorkTargetCandidate): KankakuTargetEntryData {
  return {
    clientId: ids.clientId,
    ...(ids.projectId !== undefined ? { projectId: ids.projectId } : {}),
    ...(ids.hubTaskId !== undefined ? { hubTaskId: ids.hubTaskId } : {}),
  };
}

/**
 * Owns the session-level hub target override (`/kankaku target pick`), its
 * restore/persist round-trip through session entries, and target
 * resolution for both the in-progress run and the idle status line. See
 * README "Hub (PocketBase)" and `domain/work-target.ts#resolveWorkTarget`.
 */
export function createSessionTarget(deps: SessionTargetDeps): SessionTarget {
  const cwd = deps.cwd ?? (() => process.cwd());
  const scheduleTimeout = deps.setTimeout ?? setTimeout;
  const cancelTimeout = deps.clearTimeout ?? clearTimeout;
  const firstFetchDeadlineMs = deps.firstFetchDeadlineMs ?? DEFAULT_FIRST_FETCH_DEADLINE_MS;
  const pickerRefreshDeadlineMs = deps.pickerRefreshDeadlineMs ?? DEFAULT_PICKER_REFRESH_DEADLINE_MS;

  /** Session-level override, restored on `session_start` or set by an explicit pick/skip/legacy command. */
  let sessionOverride: WorkTargetSessionOverride;
  /** Project config ids read once per run (first record build) so checkpoints do not hit the filesystem repeatedly. */
  let runProjectIds: { value: WorkTargetCandidate | undefined } | undefined;
  /** Only notify "hub unreachable" once per process for the silent `ensurePicked`/`pick` path. */
  let notifiedUnreachable = false;

  function restore(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as { type: string; customType?: string; data?: unknown };
      if (entry.type === "custom" && entry.customType === TARGET_ENTRY_TYPE) {
        const data = entry.data as KankakuTargetEntryData | undefined;
        if (data?.skipped === true) {
          sessionOverride = "skipped";
        } else if (typeof data?.clientId === "string") {
          sessionOverride = {
            clientId: data.clientId,
            ...(typeof data.projectId === "string" ? { projectId: data.projectId } : {}),
            ...(typeof data.hubTaskId === "string" ? { hubTaskId: data.hubTaskId } : {}),
          };
        } else {
          sessionOverride = undefined;
        }
        return;
      }
    }
    sessionOverride = undefined;
  }

  function computeTarget(projectIds: WorkTargetCandidate | undefined): WorkTarget | undefined {
    const snapshot = deps.catalog.read();
    return resolveWorkTarget({
      session: sessionOverride,
      project: projectIds,
      cwd: cwd(),
      clients: snapshot?.clients ?? [],
      projects: snapshot?.projects ?? [],
      tasks: snapshot?.tasks ?? [],
    });
  }

  function effectiveTarget(): WorkTarget | undefined {
    return computeTarget(deps.resolveProjectConfigIds());
  }

  function effectiveSource(): WorkTargetSourceName | undefined {
    const snapshot = deps.catalog.read();
    return resolveWorkTargetSource({
      session: sessionOverride,
      project: deps.resolveProjectConfigIds(),
      cwd: cwd(),
      clients: snapshot?.clients ?? [],
      projects: snapshot?.projects ?? [],
    });
  }

  function runIds(): WorkTargetCandidate | undefined {
    if (!runProjectIds) {
      runProjectIds = { value: deps.resolveProjectConfigIds() };
    }
    return runProjectIds.value;
  }

  function runTarget(): WorkTarget | undefined {
    return deps.role === "orchestrator" ? computeTarget(runIds()) : undefined;
  }

  function idleTarget(): WorkTarget | undefined {
    const ids = runProjectIds ? runProjectIds.value : deps.resolveProjectConfigIds();
    return deps.role === "orchestrator" ? computeTarget(ids) : undefined;
  }

  function endRun(): void {
    runProjectIds = undefined;
  }

  function notifyUnreachableOnce(ctx: ExtensionContext): void {
    if (notifiedUnreachable) return;
    notifiedUnreachable = true;
    if (ctx.hasUI) ctx.ui.notify("kankaku: hub unreachable, using local labels", "warning");
  }

  /**
   * The no-cache-at-all path: one awaited refresh bounded by an *overall*
   * deadline ({@link SessionTargetDeps.firstFetchDeadlineMs}, default
   * 5000ms) — not merely the hub client's own per-request timeout, which
   * alone does not bound the whole sequence of a lazy auth, pagination,
   * and a possible 401 retry. The deadline is enforced with an
   * `AbortSignal` composed, per request, with that request's own
   * per-request timeout (see `pocketbase-client.ts#rawFetch`). Notifies
   * "hub unreachable" at most once when no snapshot is available at all,
   * whether because the hub failed outright or because the deadline fired
   * first — both are treated identically.
   */
  async function awaitFirstFetch(ctx: ExtensionContext): Promise<CatalogSnapshot | undefined> {
    const controller = new AbortController();
    const timer = scheduleTimeout(() => controller.abort(), firstFetchDeadlineMs);
    let fresh: CatalogSnapshot | undefined;
    try {
      fresh = await deps.catalog.refresh(controller.signal);
    } finally {
      cancelTimeout(timer);
    }
    if (!fresh) {
      notifyUnreachableOnce(ctx);
    }
    return fresh;
  }

  /**
   * Races an already-started background refresh against
   * {@link SessionTargetDeps.pickerRefreshDeadlineMs} (default 1500ms): if
   * the refresh lands in time (and did not fail — `refresh()` resolving
   * `undefined` falls back exactly like a deadline miss, with no
   * notification), the picker shows the fresh snapshot; otherwise it
   * shows `cached`. The refresh is never aborted here — it keeps running
   * in the background, and `catalog.read()` reflects it once it resolves,
   * exactly as it would without a picker in the way.
   */
  function awaitPickerRefresh(
    refreshPromise: Promise<CatalogSnapshot | undefined>,
    cached: CatalogSnapshot,
  ): Promise<CatalogSnapshot> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = scheduleTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(cached);
      }, pickerRefreshDeadlineMs);
      void refreshPromise.then((fresh) => {
        if (settled) return;
        settled = true;
        cancelTimeout(timer);
        resolve(fresh ?? cached);
      });
    });
  }

  /** Resolves silently (project config / `repoPaths`) against `snapshot`, or shows the picker with it. */
  async function resolveOrShowPicker(pi: ExtensionAPI, ctx: ExtensionContext, snapshot: CatalogSnapshot): Promise<void> {
    const projectIds = deps.resolveProjectConfigIds();
    const resolved = resolveWorkTarget({
      project: projectIds,
      cwd: cwd(),
      clients: snapshot.clients,
      projects: snapshot.projects,
    });
    if (resolved) return;

    await runPicker(pi, ctx, snapshot);
  }

  async function runPicker(pi: ExtensionAPI, ctx: ExtensionContext, snapshot: CatalogSnapshot): Promise<void> {
    const result = await pickTarget(ctx, snapshot);

    if (result.kind === "skipped") {
      sessionOverride = "skipped";
      pi.appendEntry<KankakuTargetEntryData>(TARGET_ENTRY_TYPE, { skipped: true });
      return;
    }

    const ids = candidateFrom(result.target);
    sessionOverride = ids;
    pi.appendEntry<KankakuTargetEntryData>(TARGET_ENTRY_TYPE, entryDataFrom(ids));

    const remember = await ctx.ui.confirm("kankaku", `Remember ${formatWorkTargetLabel(result.target)} for this repository?`);
    if (remember) {
      deps.persistProjectConfig(ids);
    }
  }

  async function ensurePicked(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    if (deps.role !== "orchestrator" || !ctx.hasUI) return;
    if (sessionOverride !== undefined) return;

    const cached = deps.catalog.read();
    if (!cached) {
      const fresh = await awaitFirstFetch(ctx);
      if (!fresh) return;
      await resolveOrShowPicker(pi, ctx, fresh);
      return;
    }

    // Always start a refresh, regardless of staleness (the owner hit a
    // clients/projects change that a merely-stale-TTL check missed). Silent
    // resolution below returns without ever awaiting it; the refresh keeps
    // running and `catalog.read()` reflects it once it lands.
    const refreshPromise = deps.catalog.refresh();

    const projectIds = deps.resolveProjectConfigIds();
    const resolved = resolveWorkTarget({
      project: projectIds,
      cwd: cwd(),
      clients: cached.clients,
      projects: cached.projects,
    });
    if (resolved) return;

    const snapshot = await awaitPickerRefresh(refreshPromise, cached);
    await runPicker(pi, ctx, snapshot);
  }

  async function pick(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const cached = deps.catalog.read();
    if (!cached) {
      const fresh = await awaitFirstFetch(ctx);
      if (!fresh) return;
      await runPicker(pi, ctx, fresh);
      return;
    }

    const refreshPromise = deps.catalog.refresh();
    const snapshot = await awaitPickerRefresh(refreshPromise, cached);
    await runPicker(pi, ctx, snapshot);
  }

  function setExplicit(pi: ExtensionAPI, ids: WorkTargetCandidate): void {
    sessionOverride = ids;
    pi.appendEntry<KankakuTargetEntryData>(TARGET_ENTRY_TYPE, entryDataFrom(ids));
  }

  function clear(pi: ExtensionAPI): void {
    sessionOverride = undefined;
    pi.appendEntry<KankakuTargetEntryData>(TARGET_ENTRY_TYPE, {});
  }

  async function pickTask(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    if (deps.role !== "orchestrator" || !ctx.hasUI) return;

    const target = effectiveTarget();
    if (!target || target.projectId === undefined) {
      ctx.ui.notify("kankaku: Pick a client and project first (/kankaku target pick)", "warning");
      return;
    }

    const tasks = deps.catalog.read()?.tasks ?? [];
    const result = await pickHubTask(ctx, tasks, target.projectId);

    if (result.kind === "empty") {
      ctx.ui.notify(`kankaku: No open tasks for ${target.projectName ?? target.projectId} in the hub`, "warning");
      return;
    }
    if (result.kind === "skipped") return;

    const ids: WorkTargetCandidate = { ...candidateFrom(target), hubTaskId: result.task.id };
    sessionOverride = ids;
    pi.appendEntry<KankakuTargetEntryData>(TARGET_ENTRY_TYPE, entryDataFrom(ids));

    const updated = effectiveTarget();
    if (updated) ctx.ui.notify(`kankaku: task set to ${formatWorkTargetLabel(updated)}`);
  }

  function clearTask(pi: ExtensionAPI): void {
    if (sessionOverride === undefined || sessionOverride === "skipped") return;
    if (sessionOverride.hubTaskId === undefined) return;
    const { hubTaskId: _hubTaskId, ...rest } = sessionOverride;
    sessionOverride = rest;
    pi.appendEntry<KankakuTargetEntryData>(TARGET_ENTRY_TYPE, entryDataFrom(rest));
  }

  return { restore, ensurePicked, pick, setExplicit, clear, pickTask, clearTask, effectiveTarget, effectiveSource, runTarget, idleTarget, endRun };
}
