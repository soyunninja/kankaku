import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWorkRecord } from "../domain/work-record.ts";
import type { WorkRecord } from "../domain/work-record.ts";
import type { InflightStore } from "../ports/inflight-store.ts";

const INFLIGHT_DIR_NAME = "inflight";
const JSON_EXT = ".json";

function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Best effort: another process may have already removed it.
  }
}

/**
 * {@link InflightStore} backed by one checkpoint file per process,
 * `<dir>/inflight/<pid>.json`. `save` writes to a temp file then renames
 * it into place so a reader never observes a partially written checkpoint.
 */
export class FileInflightStore implements InflightStore {
  private readonly dir: string;
  private readonly pid: number;

  constructor(dir: string, pid: number) {
    this.dir = dir;
    this.pid = pid;
  }

  private get inflightDir(): string {
    return join(this.dir, INFLIGHT_DIR_NAME);
  }

  private filePathFor(pid: number): string {
    return join(this.inflightDir, `${pid}${JSON_EXT}`);
  }

  save(record: WorkRecord): void {
    mkdirSync(this.inflightDir, { recursive: true });
    const target = this.filePathFor(this.pid);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, target);
  }

  clear(): void {
    safeUnlink(this.filePathFor(this.pid));
  }

  recoverStale(isAlive: (pid: number) => boolean): WorkRecord[] {
    if (!existsSync(this.inflightDir)) return [];

    const recovered: WorkRecord[] = [];
    const ownFileName = `${this.pid}${JSON_EXT}`;

    for (const entry of readdirSync(this.inflightDir)) {
      if (!entry.endsWith(JSON_EXT) || entry === ownFileName) continue;

      const filePath = join(this.inflightDir, entry);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf8"));
      } catch {
        safeUnlink(filePath);
        continue;
      }

      if (!isWorkRecord(parsed)) {
        safeUnlink(filePath);
        continue;
      }

      if (isAlive(parsed.pid)) continue;

      recovered.push({ ...parsed, status: "interrupted" });
      safeUnlink(filePath);
    }

    return recovered;
  }
}
