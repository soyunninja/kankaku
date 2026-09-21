import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dedupeById } from "../domain/task-view.ts";
import type { WorkLog } from "../ports/work-log.ts";
import type { WorkRecord } from "../domain/work-record.ts";
import { isWorkRecord } from "../domain/work-record.ts";

const LOG_FILE_NAME = "worklog.jsonl";

/**
 * Append-only JSONL {@link WorkLog} backed by `<dir>/worklog.jsonl`.
 * A record is written with a single `appendFileSync` call so a parent and
 * its subagent children can write concurrently without interleaving lines.
 */
export class JsonlWorkLog implements WorkLog {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private get filePath(): string {
    return join(this.dir, LOG_FILE_NAME);
  }

  append(record: WorkRecord): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
  }

  /**
   * Cheap change signal: `mtimeMs:size` of the log file, computed with a
   * single `statSync` rather than reading the file. `"0:0"` when the file
   * does not exist yet (before the first `append`).
   */
  version(): string {
    try {
      const stats = statSync(this.filePath);
      return `${stats.mtimeMs}:${stats.size}`;
    } catch {
      return "0:0";
    }
  }

  readAll(): WorkRecord[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf8");
    const records: WorkRecord[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isWorkRecord(parsed)) {
          records.push(parsed);
        }
        // Tolerate a structurally invalid record (e.g. an incompatible
        // schema or a torn write that still parses as JSON); skip it.
      } catch {
        // Tolerate malformed lines (e.g. a torn write); skip them.
      }
    }
    // One id can be in the file twice (written at settle, then re-appended by
    // crash recovery): every reader gets it once — see dedupeById.
    return dedupeById(records);
  }
}
