import { closeSync, openSync, readSync, readdirSync, fstatSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Reader for Claude Code's session transcripts (`~/.claude/projects/...jsonl`).
 *
 * The format is internal and undocumented and may change with any Claude
 * Code release, so everything here is tolerant: a missing file, an
 * unparseable line or an unexpected field yields zero / `undefined`, never
 * an error. Only numbers, the Claude Code version, the entry point and the
 * session cost total are ever taken from a line; no message content is
 * kept. Node builtins only, so it may sit on the light hook path (which
 * only ever uses {@link statTranscriptSize} and {@link listSubagentTranscripts}).
 */

/** Most bytes read across all transcript files of one settle (16 MiB). */
export const MAX_SETTLE_BYTES = 16 * 1024 * 1024;

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Where the next read of one transcript file starts. */
export interface TranscriptPosition {
  bytes: number;
  /** The last `message.id` counted from this file, so a message split across two reads is counted once. */
  lastMessageId?: string;
  /**
   * What has been counted so far for {@link lastMessageId}. When the next read
   * starts with more lines of that message, only the growth is added. Absent
   * in a position written before this field existed: the message's lines at
   * the head of the next read are then skipped (its total is unknown).
   */
  lastMessageUsage?: TokenUsage;
}

export interface TranscriptCostState {
  totalUsd: number;
  hasUnknownModelCost: boolean;
}

export interface ParsedChunk {
  usage: TokenUsage;
  lastMessageId?: string;
  /** Counted so far for {@link lastMessageId}; carry it into the next read. Absent for a legacy position that has not advanced. */
  lastMessageUsage?: TokenUsage;
  version?: string;
  entrypoint?: string;
  costState?: TranscriptCostState;
}

export interface TranscriptRead extends ParsedChunk {
  position: TranscriptPosition;
  /** The new bytes exceeded the bound: they were skipped, not counted. */
  truncated: boolean;
}

export function zeroUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Lines that can matter besides the first few (which are tried for the version and entry point). */
const RELEVANT_LINE = /"type"\s*:\s*"(?:assistant|cost-state)"/;
const METADATA_LINES = 20;

function counted(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsage(raw: Record<string, unknown>): TokenUsage {
  return {
    input: counted(raw.input_tokens),
    output: counted(raw.output_tokens),
    cacheRead: counted(raw.cache_read_input_tokens),
    cacheWrite: counted(raw.cache_creation_input_tokens),
  };
}

/**
 * Pure: parses the text of complete transcript lines.
 *
 * - Claude Code writes one message over several adjacent lines whose usage
 *   grows (earlier lines are partial snapshots), so an `assistant` message is
 *   counted once per `message.id` by its LAST line in the chunk. A line
 *   without an id cannot be de-duplicated and is not counted.
 * - A message can straddle two reads. `previous` carries the last id and the
 *   usage counted for it: when this chunk holds more lines of that id, only
 *   the growth is added, per field and never negative. A `previous` with an
 *   id but no usage (a legacy position) skips that id's lines instead.
 * - A non-finite, negative or non-numeric usage field counts as 0.
 * - `version` and `entrypoint` come from the first line that carries each.
 * - `costState` is the last valid `cost-state` line.
 */
export function parseTranscriptChunk(
  text: string,
  previous: { lastMessageId?: string; lastMessageUsage?: TokenUsage },
): ParsedChunk {
  const finals = new Map<string, TokenUsage>();
  let lastMessageId = previous.lastMessageId;
  let version: string | undefined;
  let entrypoint: string | undefined;
  let costState: TranscriptCostState | undefined;

  let index = 0;
  for (const line of text.split("\n")) {
    const lineNumber = index++;
    if (line.trim() === "") continue;
    const needsMetadata = (version === undefined || entrypoint === undefined) && lineNumber < METADATA_LINES;
    if (!needsMetadata && !RELEVANT_LINE.test(line)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;

    if (version === undefined && typeof parsed.version === "string" && parsed.version !== "") version = parsed.version;
    if (entrypoint === undefined && typeof parsed.entrypoint === "string" && parsed.entrypoint !== "") entrypoint = parsed.entrypoint;

    if (parsed.type === "assistant") {
      const message = parsed.message;
      if (!isObject(message) || typeof message.id !== "string" || message.id === "") continue;
      lastMessageId = message.id;
      if (isObject(message.usage)) finals.set(message.id, parseUsage(message.usage));
      else if (!finals.has(message.id)) finals.set(message.id, zeroUsage());
    } else if (parsed.type === "cost-state") {
      const total = parsed.totalCostUSD;
      if (typeof total !== "number" || !Number.isFinite(total) || total < 0) continue;
      costState = { totalUsd: total, hasUnknownModelCost: parsed.hasUnknownModelCost === true };
    }
  }

  const usage = zeroUsage();
  for (const [id, final] of finals) {
    let added = final;
    if (id === previous.lastMessageId) {
      const before = previous.lastMessageUsage;
      if (before === undefined) continue; // legacy: this message's total so far is unknown, skip it
      added = {
        input: Math.max(0, final.input - before.input),
        output: Math.max(0, final.output - before.output),
        cacheRead: Math.max(0, final.cacheRead - before.cacheRead),
        cacheWrite: Math.max(0, final.cacheWrite - before.cacheWrite),
      };
    }
    usage.input += added.input;
    usage.output += added.output;
    usage.cacheRead += added.cacheRead;
    usage.cacheWrite += added.cacheWrite;
  }

  let lastMessageUsage: TokenUsage | undefined = previous.lastMessageUsage;
  if (lastMessageId !== undefined && finals.has(lastMessageId)) {
    const final = finals.get(lastMessageId)!;
    if (lastMessageId !== previous.lastMessageId) lastMessageUsage = final;
    else if (previous.lastMessageUsage !== undefined) {
      const before = previous.lastMessageUsage;
      lastMessageUsage = {
        input: Math.max(before.input, final.input),
        output: Math.max(before.output, final.output),
        cacheRead: Math.max(before.cacheRead, final.cacheRead),
        cacheWrite: Math.max(before.cacheWrite, final.cacheWrite),
      };
    }
  }

  return {
    usage,
    ...(lastMessageId !== undefined ? { lastMessageId } : {}),
    ...(lastMessageUsage !== undefined ? { lastMessageUsage } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(entrypoint !== undefined ? { entrypoint } : {}),
    ...(costState !== undefined ? { costState } : {}),
  };
}

/**
 * Reads the complete lines after `position.bytes` and parses them.
 *
 * - A trailing partial line (no newline yet) is not consumed: the returned
 *   position stops before it.
 * - A file shorter than the stored position was rotated or replaced: it is
 *   read from 0 and the stale `lastMessageId` is dropped.
 * - More than `maxBytes` of new content (default {@link MAX_SETTLE_BYTES}) is
 *   not read at all: the position jumps to the end of the file, nothing is
 *   counted and `truncated` is set, so a hook never times out on a huge file.
 * - A missing or unreadable file returns zero usage and the same position.
 */
export function readTranscriptSince(
  file: string,
  position: TranscriptPosition,
  options: { maxBytes?: number } = {},
): TranscriptRead {
  const unchanged: TranscriptRead = { usage: zeroUsage(), position, truncated: false };
  const maxBytes = options.maxBytes ?? MAX_SETTLE_BYTES;
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return unchanged;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return unchanged;
    const size = stats.size;
    const replaced = size < position.bytes;
    const start = replaced ? 0 : position.bytes;
    const lastMessageId = replaced ? undefined : position.lastMessageId;
    const lastMessageUsage = replaced ? undefined : position.lastMessageUsage;
    const carried = { ...(lastMessageId !== undefined ? { lastMessageId } : {}), ...(lastMessageUsage !== undefined ? { lastMessageUsage } : {}) };
    const length = size - start;
    if (length === 0) {
      return { usage: zeroUsage(), position: { bytes: start, ...carried }, truncated: false };
    }
    if (length > maxBytes) {
      return {
        usage: zeroUsage(),
        position: { bytes: size, ...carried },
        truncated: true,
      };
    }

    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const n = readSync(fd, buffer, filled, length - filled, start + filled);
      if (n === 0) break;
      filled += n;
    }
    const lastNewline = buffer.subarray(0, filled).lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return { usage: zeroUsage(), position: { bytes: start, ...carried }, truncated: false };
    }
    const consumed = lastNewline + 1;
    const parsed = parseTranscriptChunk(buffer.subarray(0, consumed).toString("utf8"), carried);
    return {
      ...parsed,
      position: {
        bytes: start + consumed,
        ...(parsed.lastMessageId !== undefined ? { lastMessageId: parsed.lastMessageId } : {}),
        ...(parsed.lastMessageUsage !== undefined ? { lastMessageUsage: parsed.lastMessageUsage } : {}),
      },
      truncated: false,
    };
  } catch {
    return unchanged;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing to do
    }
  }
}

/** Current size of a file in bytes (metadata only, no read), or `undefined` when it cannot be statted. */
export function statTranscriptSize(file: string): number | undefined {
  try {
    const stats = statSync(file);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The subagent transcripts of a session: `*.jsonl` files in
 * `<dirname>/<session id>/subagents/`, sorted, everything else ignored.
 * Empty when the directory does not exist.
 */
export function listSubagentTranscripts(sessionTranscriptPath: string): string[] {
  const dir = join(dirname(sessionTranscriptPath), basename(sessionTranscriptPath, ".jsonl"), "subagents");
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(dir, entry.name))
    .sort();
}
