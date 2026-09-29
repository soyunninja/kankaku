import type { TranscriptState } from "./session-state.ts";
import {
  MAX_SETTLE_BYTES,
  listSubagentTranscripts,
  readTranscriptHead,
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
    ...(existing?.model !== undefined ? { model: existing.model } : {}),
  };
}

/** Poll every 25 ms; not before 100 ms and not after 300 ms since the hook started (see {@link waitForTranscript}). */
export const TRANSCRIPT_POLL_MS = 25;
export const TRANSCRIPT_WAIT_MIN_MS = 100;
export const TRANSCRIPT_WAIT_MAX_MS = 300;

/**
 * Claude Code writes the transcript asynchronously: the last assistant lines
 * reach the disk shortly AFTER the Stop hook has started, while earlier
 * assistant messages of the same prompt are usually on disk long before. So
 * a line being there is not enough. Before a settle reads, poll the main
 * transcript every {@link TRANSCRIPT_POLL_MS} until ALL hold: at least
 * {@link TRANSCRIPT_WAIT_MIN_MS} have passed since `startedAt` (when the hook
 * process started), its size did not change across two consecutive polls,
 * and its new bytes hold a complete assistant line. It gives up
 * {@link TRANSCRIPT_WAIT_MAX_MS} after `startedAt` regardless; time already
 * spent (the statusline wait) counts, so a hook that waited 300 ms or more
 * does not sleep again. The caller then reads whatever is there. Clock and
 * sleep are injected. Never throws.
 */
export async function waitForTranscript(
  transcript: TranscriptState | undefined,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
  startedAt: number = clock.now(),
): Promise<void> {
  if (!transcript) return;
  const position = transcript.offsets[transcript.path] ?? { bytes: 0 };
  let previousSize: number | undefined;
  for (;;) {
    const elapsed = clock.now() - startedAt;
    if (elapsed >= TRANSCRIPT_WAIT_MAX_MS) return;
    let ready = false;
    try {
      const size = statTranscriptSize(transcript.path);
      const read = readTranscriptSince(transcript.path, position);
      const sawLine =
        read.lastMessageId !== undefined &&
        (read.lastMessageId !== position.lastMessageId || read.usage.input + read.usage.output + read.usage.cacheRead + read.usage.cacheWrite > 0);
      ready = elapsed >= TRANSCRIPT_WAIT_MIN_MS && sawLine && size !== undefined && size === previousSize;
      previousSize = size;
    } catch {
      return;
    }
    if (ready) return;
    await clock.sleep(Math.min(TRANSCRIPT_POLL_MS, TRANSCRIPT_WAIT_MAX_MS - elapsed));
  }
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
  let mainModel: string | undefined;
  let subagentModel: string | undefined;
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
    if (file === transcript.path) {
      costState = result.costState;
      mainModel = result.model;
    } else if (result.model !== undefined) {
      subagentModel = result.model;
    }
  }

  if ((version ?? transcript.agentVersion) === undefined || (entrypoint ?? transcript.entrypoint) === undefined) {
    const head = readTranscriptHead(transcript.path);
    version ??= head.version;
    entrypoint ??= head.entrypoint;
  }
  const agentVersion = version ?? transcript.agentVersion;
  const knownEntrypoint = entrypoint ?? transcript.entrypoint;
  const model = mainModel ?? transcript.model ?? subagentModel;
  return {
    tokens: truncated ? undefined : total,
    transcript: {
      path: transcript.path,
      offsets,
      ...(agentVersion !== undefined ? { agentVersion } : {}),
      ...(knownEntrypoint !== undefined ? { entrypoint: knownEntrypoint } : {}),
      ...(model !== undefined ? { model } : {}),
    },
    ...(costState !== undefined ? { costState } : {}),
    truncated,
  };
}
