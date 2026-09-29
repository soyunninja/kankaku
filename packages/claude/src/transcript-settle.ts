import type { TranscriptState } from "./session-state.ts";
import {
  MAX_SETTLE_BYTES,
  listSubagentTranscripts,
  readTranscriptSince,
  statTranscriptSize,
  type TokenUsage,
  type TranscriptCostState,
  type TranscriptPosition,
} from "./transcript.ts";

/**
 * Session-level use of the transcript reader: which files belong to a
 * session, where each one is read from, and what a settle learns from them.
 * Node builtins only (see `transcript.ts`).
 */

/**
 * `UserPromptSubmit`: remember the transcript path and, when no position is
 * known yet, the CURRENT size of the main file and of every subagent file,
 * so a session that existed before the plugin (or was resumed) does not
 * read its history at the first settle. Metadata only: no file is read. A
 * new path (the session moved to another file) restarts the positions.
 */
export function trackTranscriptAtSubmit(existing: TranscriptState | undefined, path: string | undefined): TranscriptState | undefined {
  if (path === undefined || path === "") return existing;
  if (existing && existing.path === path && Object.keys(existing.offsets).length > 0) return existing;

  const offsets: Record<string, TranscriptPosition> = {};
  for (const file of [path, ...listSubagentTranscripts(path)]) {
    const size = statTranscriptSize(file);
    if (size !== undefined) offsets[file] = { bytes: size };
  }
  return {
    path,
    offsets,
    ...(existing?.agentVersion !== undefined ? { agentVersion: existing.agentVersion } : {}),
    ...(existing?.entrypoint !== undefined ? { entrypoint: existing.entrypoint } : {}),
  };
}

export interface SettledTranscripts {
  /** Tokens added since the stored positions; `undefined` when any file exceeded the read bound (the record then simply lacks tokens). */
  tokens: TokenUsage | undefined;
  /** The state with the advanced positions and any newly learned version / entry point. */
  transcript: TranscriptState;
  /** The last `cost-state` of the MAIN transcript among the bytes read. */
  costState?: TranscriptCostState;
  truncated: boolean;
}

/**
 * Settle: read everything appended since the stored positions, in the main
 * transcript and in every subagent file (a file without a position starts
 * at 0), sum it, and return the advanced positions. At most
 * `maxBytes` (default {@link MAX_SETTLE_BYTES}) are read across all files;
 * a file whose new content does not fit is skipped to its end without
 * counting and the whole result carries no tokens.
 */
export function settleTranscripts(
  transcript: TranscriptState | undefined,
  options: { maxBytes?: number } = {},
): SettledTranscripts | undefined {
  if (!transcript) return undefined;
  let remaining = options.maxBytes ?? MAX_SETTLE_BYTES;
  const offsets: Record<string, TranscriptPosition> = { ...transcript.offsets };
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let truncated = false;
  let version: string | undefined;
  let entrypoint: string | undefined;
  let costState: TranscriptCostState | undefined;

  const files = [transcript.path, ...listSubagentTranscripts(transcript.path)];
  for (const file of files) {
    const before = offsets[file] ?? { bytes: 0 };
    const result = readTranscriptSince(file, before, { maxBytes: remaining });
    if (result.truncated) {
      truncated = true;
      remaining = 0;
    } else {
      const start = result.position.bytes >= before.bytes ? before.bytes : 0;
      remaining = Math.max(0, remaining - (result.position.bytes - start));
    }
    if (file in offsets || result.position.bytes > 0) offsets[file] = result.position;
    total.input += result.usage.input;
    total.output += result.usage.output;
    total.cacheRead += result.usage.cacheRead;
    total.cacheWrite += result.usage.cacheWrite;
    if (version === undefined) version = result.version;
    if (entrypoint === undefined) entrypoint = result.entrypoint;
    if (file === transcript.path) costState = result.costState;
  }

  const agentVersion = version ?? transcript.agentVersion;
  const knownEntrypoint = entrypoint ?? transcript.entrypoint;
  return {
    tokens: truncated ? undefined : total,
    transcript: {
      path: transcript.path,
      offsets,
      ...(agentVersion !== undefined ? { agentVersion } : {}),
      ...(knownEntrypoint !== undefined ? { entrypoint: knownEntrypoint } : {}),
    },
    ...(costState !== undefined ? { costState } : {}),
    truncated,
  };
}
