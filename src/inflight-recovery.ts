import { unlinkSync } from "node:fs";
import { basename } from "node:path";
import type { WorkRecord } from "kankaku/domain";
import { listStateFiles } from "./paths.ts";
import { readState } from "./session-state.ts";
import { readEventLog } from "./event-log.ts";
import { splitPrompts, replayPrompt } from "./replay.ts";
import { buildClaudeRecord } from "./record.ts";

export interface RecoverStaleSessionsInput {
  claudeDir: string;
  currentSessionId: string;
  isAlive: (pid: number) => boolean;
  now: number;
}

/**
 * Crash recovery: for every other session's state file whose pid is dead,
 * replay its still-open prompt (if any) into an `interrupted` record, then
 * delete both of that session's files. A live session is left untouched.
 */
export function recoverStaleSessions(input: RecoverStaleSessionsInput): WorkRecord[] {
  const records: WorkRecord[] = [];

  for (const stateFile of listStateFiles(input.claudeDir)) {
    const sessionId = sessionIdFromStateFile(stateFile);
    if (!sessionId || sessionId === input.currentSessionId) continue;

    const state = readState(stateFile);
    const eventsFile = stateFile.replace(/\.state\.json$/, ".events.jsonl");

    if (!state) {
      safeUnlink(stateFile);
      safeUnlink(eventsFile);
      continue;
    }
    if (input.isAlive(state.pid)) continue;

    if (state.promptOpen) {
      const events = readEventLog(eventsFile);
      const prompts = splitPrompts(events);
      const last = prompts[prompts.length - 1];
      if (last && last.open) {
        const core = replayPrompt(last, { settledAt: input.now });
        if (core) records.push(buildClaudeRecord(core, state, sessionId));
      }
    }

    safeUnlink(stateFile);
    safeUnlink(eventsFile);
  }

  return records;
}

function sessionIdFromStateFile(file: string): string | undefined {
  const match = basename(file).match(/^(.*)\.state\.json$/);
  return match?.[1];
}

function safeUnlink(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}
