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
}

export interface TranscriptCostState {
  totalUsd: number;
  hasUnknownModelCost: boolean;
}

export interface ParsedChunk {
  usage: TokenUsage;
  lastMessageId?: string;
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

/**
 * Pure: parses the text of complete transcript lines.
 *
 * - `assistant` lines are counted once per `message.id` (Claude Code repeats
 *   one message over several lines); a line whose id is `lastMessageId` was
 *   counted by the previous read and is skipped. A line without an id cannot
 *   be de-duplicated and is not counted.
 * - A non-finite, negative or non-numeric usage field counts as 0.
 * - `version` and `entrypoint` come from the first line that carries each.
 * - `costState` is the last valid `cost-state` line.
 */
export function parseTranscriptChunk(text: string, options: { lastMessageId?: string }): ParsedChunk {
  const usage = zeroUsage();
  const seen = new Set<string>();
  if (options.lastMessageId !== undefined) seen.add(options.lastMessageId);
  let lastMessageId = options.lastMessageId;
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
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      lastMessageId = message.id;
      const raw = message.usage;
      if (!isObject(raw)) continue;
      usage.input += counted(raw.input_tokens);
      usage.output += counted(raw.output_tokens);
      usage.cacheRead += counted(raw.cache_read_input_tokens);
      usage.cacheWrite += counted(raw.cache_creation_input_tokens);
    } else if (parsed.type === "cost-state") {
      const total = parsed.totalCostUSD;
      if (typeof total !== "number" || !Number.isFinite(total) || total < 0) continue;
      costState = { totalUsd: total, hasUnknownModelCost: parsed.hasUnknownModelCost === true };
    }
  }

  return {
    usage,
    ...(lastMessageId !== undefined ? { lastMessageId } : {}),
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
    const length = size - start;
    if (length === 0) {
      return { usage: zeroUsage(), position: { bytes: start, ...(lastMessageId !== undefined ? { lastMessageId } : {}) }, truncated: false };
    }
    if (length > maxBytes) {
      return {
        usage: zeroUsage(),
        position: { bytes: size, ...(lastMessageId !== undefined ? { lastMessageId } : {}) },
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
      return { usage: zeroUsage(), position: { bytes: start, ...(lastMessageId !== undefined ? { lastMessageId } : {}) }, truncated: false };
    }
    const consumed = lastNewline + 1;
    const parsed = parseTranscriptChunk(buffer.subarray(0, consumed).toString("utf8"), { lastMessageId });
    return {
      ...parsed,
      position: { bytes: start + consumed, ...(parsed.lastMessageId !== undefined ? { lastMessageId: parsed.lastMessageId } : {}) },
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
