import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readEvents, serializeEvent, type Event } from "./events.ts";

/** Appends one event line, creating parent directories as needed. */
export function appendEvent(file: string, event: Event): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, serializeEvent(event) + "\n");
}

/** Empty array when the file does not exist. Tolerant of malformed/truncated lines (see `readEvents`). */
export function readEventLog(file: string): Event[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return readEvents(text);
}

/**
 * Rewrites the events file atomically (tmp+rename) so it holds only `keep`
 * — used to drop a prompt's events once it has settled, keeping only the
 * still-open prompt's events, if any.
 */
export function dropSettledPrompts(file: string, keep: Event[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const text = keep.length === 0 ? "" : keep.map(serializeEvent).join("\n") + "\n";
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
