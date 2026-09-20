import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyRegistryEntries, DEFAULT_MAX_ENTRY_AGE_MS } from "../domain/registry-health.ts";
import type { RegistryClassification } from "../domain/registry-health.ts";
import type { ProcessRegistry, RegistryEntry, RegistrySweepDeps } from "../ports/process-registry.ts";

const RUN_DIR_NAME = "run";
const JSON_EXT = ".json";

function isOrchestratorRef(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return typeof ref["pid"] === "number" && typeof ref["project"] === "string" && typeof ref["startedAt"] === "string";
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["pid"] === "number" &&
    typeof record["parentPid"] === "number" &&
    (record["role"] === "orchestrator" || record["role"] === "subagent") &&
    typeof record["project"] === "string" &&
    typeof record["dir"] === "string" &&
    typeof record["startedAt"] === "string" &&
    isOrchestratorRef(record["orchestratorRef"]) &&
    (record["processStartId"] === undefined || typeof record["processStartId"] === "number")
  );
}

function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Best effort: another process (or a concurrent sweep) may have already removed it.
  }
}

/** Default `isAlive`: probe with signal 0 — mirrors `pi-tracker.ts`/`sync-state-store.ts`'s own default. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * {@link ProcessRegistry} backed by `<homeDir>/.kankaku/run/<pid>.json`,
 * machine-wide and independent of any project's `KANKAKU_DIR` (ADR 0023).
 * `record()` writes atomically (tmp file + rename), mirroring
 * `file-inflight-store.ts`. Every operation degrades to "registry
 * unavailable" (a no-op write, an empty read) on any failure — including a
 * `homeDir()` that throws (no `HOME`, a sandboxed environment) — rather
 * than propagating, since this is an enhancement to subagent detection and
 * must never block or crash the extension it improves.
 */
export class MachineProcessRegistry implements ProcessRegistry {
  private readonly homeDir: () => string;

  constructor(homeDir: () => string) {
    this.homeDir = homeDir;
  }

  private runDir(): string | undefined {
    try {
      return join(this.homeDir(), ".kankaku", RUN_DIR_NAME);
    } catch {
      return undefined;
    }
  }

  record(entry: RegistryEntry, isAlive: (pid: number) => boolean = defaultIsAlive, sweepDeps: RegistrySweepDeps = {}): void {
    const dir = this.runDir();
    if (dir === undefined) return;

    try {
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `${entry.pid}${JSON_EXT}`);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, target);
    } catch {
      // Best effort: a write failure (no permission, disk full) must not
      // block or fail the run it would otherwise track.
      return;
    }

    this.sweep(dir, entry.pid, isAlive, sweepDeps);
  }

  removeOwn(pid: number, processStartId: number | undefined): void {
    const dir = this.runDir();
    if (dir === undefined) return;

    const target = join(dir, `${pid}${JSON_EXT}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      return; // nothing to remove, or unreadable — best effort.
    }

    if (!isRegistryEntry(parsed) || parsed.pid !== pid || parsed.processStartId !== processStartId) {
      // Not verifiably this process's own entry (already overwritten by a
      // pid-reuse successor, or a mismatched identity) — never touch it.
      return;
    }

    safeUnlink(target);
  }

  readAll(): RegistryEntry[] {
    const dir = this.runDir();
    if (dir === undefined || !existsSync(dir)) return [];

    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }

    const entries: RegistryEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(JSON_EXT)) continue; // skips .tmp files too (they never end in plain .json)
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (isRegistryEntry(parsed)) entries.push(parsed);
        // Tolerate a structurally invalid entry (e.g. a torn write); skip it.
      } catch {
        // Tolerate malformed/corrupt files; skip them.
      }
    }
    return entries;
  }

  /**
   * Read-only registry health snapshot for `/kankaku doctor`
   * (SUBAGENT-REQ-017): every currently-persisted entry, classified as kept
   * or discarded-and-why via the same pure classifier a real sweep uses —
   * but without deleting anything, and (by default) without re-verifying
   * any pid's live start identity, so this stays a cheap, no-extra-spawn
   * diagnostic: a `stale-reuse` verdict therefore only ever shows up here
   * when the caller explicitly injects a fresh `liveStartId` (e.g. from an
   * ancestry snapshot it already has); otherwise such entries simply read
   * as "kept" here even though a real `record()` sweep, run by a process
   * that *does* have that live data, would already have discarded them.
   */
  health(deps: { isAlive?: (pid: number) => boolean; liveStartId?: (pid: number) => number | undefined; now?: number } = {}): RegistryClassification {
    const entries = this.readAll();
    return classifyRegistryEntries(entries, -1, {
      isAlive: deps.isAlive ?? defaultIsAlive,
      liveStartId: deps.liveStartId ?? (() => undefined),
      now: deps.now ?? Date.now(),
      maxAgeMs: DEFAULT_MAX_ENTRY_AGE_MS,
    });
  }

  /**
   * Opportunistic sweep, run whenever this process writes its own entry
   * (mirrors `file-inflight-store.ts`'s stray-tmp-file sweep pattern), so
   * `run/` does not grow unbounded and never keeps serving a stale
   * identity (SUBAGENT-REQ-010, and the PID-reuse fix). Delegates the
   * actual keep/discard decision to the pure
   * `domain/registry-health.ts#classifyRegistryEntries`, fed with every
   * *structurally valid* on-disk entry (a corrupt/torn file is simply
   * skipped here, same as `readAll`) plus whatever this call's own
   * `isAlive`/`liveStartId` can tell it. Never removes the entry this call
   * itself just wrote, regardless of what those report for it.
   */
  private sweep(dir: string, ownPid: number, isAlive: (pid: number) => boolean, sweepDeps: RegistrySweepDeps): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }

    const entries: RegistryEntry[] = [];
    const pathByPid = new Map<number, string>();
    for (const name of names) {
      if (!name.endsWith(JSON_EXT)) continue;
      const pid = Number(name.slice(0, -JSON_EXT.length));
      if (!Number.isFinite(pid)) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (isRegistryEntry(parsed)) {
          entries.push(parsed);
          pathByPid.set(pid, join(dir, name));
        }
        // A structurally invalid/corrupt file is left alone here — readAll
        // already tolerates it by skipping, and this sweep only acts on
        // entries it can positively classify.
      } catch {
        // Tolerate malformed/corrupt files; skip them.
      }
    }

    const { discard } = classifyRegistryEntries(entries, ownPid, {
      isAlive,
      liveStartId: sweepDeps.liveStartId ?? (() => undefined),
      now: sweepDeps.now ?? Date.now(),
      maxAgeMs: DEFAULT_MAX_ENTRY_AGE_MS,
    });

    for (const { entry } of discard) {
      const path = pathByPid.get(entry.pid);
      if (path) safeUnlink(path);
    }
  }
}
