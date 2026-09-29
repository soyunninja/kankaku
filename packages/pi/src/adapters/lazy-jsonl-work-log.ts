import type { WorkRecord } from "../domain/work-record.ts";
import type { WorkLog } from "../ports/work-log.ts";
import { JsonlWorkLog } from "./jsonl-work-log.ts";
import { resolveKankakuDir } from "./kankaku-dir.ts";

/**
 * {@link WorkLog} that resolves a relative log directory lazily: against the
 * project of the first appended record, or against `fallbackCwd()` when a
 * read happens before any record was written in this process.
 */
export class LazyJsonlWorkLog implements WorkLog {
  private readonly dirOrRelative: string;
  private readonly fallbackCwd: () => string;
  private resolved: JsonlWorkLog | undefined;

  constructor(dirOrRelative: string, fallbackCwd: () => string = () => process.cwd()) {
    this.dirOrRelative = dirOrRelative;
    this.fallbackCwd = fallbackCwd;
  }

  private resolveFor(cwd: string): JsonlWorkLog {
    if (!this.resolved) {
      this.resolved = new JsonlWorkLog(resolveKankakuDir(this.dirOrRelative, cwd));
    }
    return this.resolved;
  }

  append(record: WorkRecord): void {
    this.resolveFor(record.project).append(record);
  }

  readAll(): WorkRecord[] {
    return this.resolveFor(this.fallbackCwd()).readAll();
  }

  version(): string {
    return this.resolveFor(this.fallbackCwd()).version();
  }
}
