import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessRegistry, RegistryEntry } from "../ports/process-registry.ts";

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
    isOrchestratorRef(record["orchestratorRef"])
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

  record(entry: RegistryEntry, isAlive: (pid: number) => boolean = defaultIsAlive): void {
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

    this.sweep(dir, isAlive, entry.pid);
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
   * Opportunistic sweep of dead-process entries, run whenever this process
   * writes its own entry (mirrors `file-inflight-store.ts`'s stray-tmp-file
   * sweep pattern), so `run/` does not grow unbounded (SUBAGENT-REQ-010).
   * Never removes the entry this call just wrote, regardless of what
   * `isAlive` reports for it.
   */
  private sweep(dir: string, isAlive: (pid: number) => boolean, ownPid: number): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names) {
      if (!name.endsWith(JSON_EXT)) continue;
      const pid = Number(name.slice(0, -JSON_EXT.length));
      if (!Number.isFinite(pid) || pid === ownPid) continue;
      if (isAlive(pid)) continue;
      safeUnlink(join(dir, name));
    }
  }
}
