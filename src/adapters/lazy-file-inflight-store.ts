import { isAbsolute, join } from "node:path";
import type { WorkRecord } from "../domain/work-record.ts";
import type { InflightStore } from "../ports/inflight-store.ts";
import { FileInflightStore } from "./file-inflight-store.ts";

/**
 * {@link InflightStore} that resolves a relative checkpoint directory
 * lazily, mirroring {@link LazyJsonlWorkLog}: against the project of the
 * first saved record, or against `fallbackCwd()` when `clear` or
 * `recoverStale` happens before any record was saved in this process
 * (e.g. `session_start`, which runs before `before_agent_start`).
 */
export class LazyFileInflightStore implements InflightStore {
  private readonly dirOrRelative: string;
  private readonly pid: number;
  private readonly fallbackCwd: () => string;
  private resolved: FileInflightStore | undefined;

  constructor(dirOrRelative: string, pid: number, fallbackCwd: () => string = () => process.cwd()) {
    this.dirOrRelative = dirOrRelative;
    this.pid = pid;
    this.fallbackCwd = fallbackCwd;
  }

  private resolveFor(cwd: string): FileInflightStore {
    if (!this.resolved) {
      const dir = isAbsolute(this.dirOrRelative) ? this.dirOrRelative : join(cwd, this.dirOrRelative);
      this.resolved = new FileInflightStore(dir, this.pid);
    }
    return this.resolved;
  }

  save(record: WorkRecord): void {
    this.resolveFor(record.project).save(record);
  }

  clear(): void {
    this.resolveFor(this.fallbackCwd()).clear();
  }

  recoverStale(isAlive: (pid: number) => boolean): WorkRecord[] {
    return this.resolveFor(this.fallbackCwd()).recoverStale(isAlive);
  }
}
