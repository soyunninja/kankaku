import { unlinkSync } from "node:fs";
import { basename } from "node:path";
import type { WorkRecord } from "kankaku-pi/domain";
import { listStateFiles, resolveTargetFile } from "./paths.ts";
import { readState } from "./session-state.ts";
import { readEventLog } from "./event-log.ts";
import { splitPrompts, replayPrompt } from "./replay.ts";
import { buildClaudeRecord } from "./record.ts";
import { readCost, deleteCost, type CostEnv } from "./cost-store.ts";
import { settleCost } from "./cost-chain.ts";
import type { RecordAssignment } from "./work-target.ts";

export interface RecoverStaleSessionsInput {
  claudeDir: string;
  currentSessionId: string;
  isAlive: (pid: number) => boolean;
  /** Fallback close time, used only when a prompt has no usable event timestamp. */
  now: number;
  env: CostEnv;
  /** Target and legacy label for a recovered session, looked up by that session's own cwd and session id (its task link). Omitted: unassigned. */
  resolveAssignment?: (cwd: string, sessionId: string) => RecordAssignment;
}

/**
 * Crash recovery: for every other session's state file whose pid is dead,
 * replay its still-open prompt (if any) into an `interrupted` record, then
 * delete that session's files (state, events, cost). A live session is left
 * untouched.
 *
 * A non-positive `pid` counts as dead regardless of what `isAlive` reports
 * (T7: the pre-fix `mergeCost` placeholder carried `pid: 0`, and the old
 * `isAlive(0)` — `process.kill(0, 0)` signals the whole process GROUP —
 * reported it alive forever). Such a placeholder also carries `cwd: ""`; an
 * open prompt with no cwd to attribute it to is discarded, not replayed.
 */
export function recoverStaleSessions(input: RecoverStaleSessionsInput): WorkRecord[] {
  const records: WorkRecord[] = [];

  for (const stateFile of listStateFiles(input.claudeDir)) {
    const sessionId = sessionIdFromStateFile(stateFile);
    if (!sessionId || sessionId === input.currentSessionId) continue;

    const state = readState(stateFile);
    const eventsFile = stateFile.replace(/\.state\.json$/, ".events.jsonl");
    const targetFile = resolveTargetFile(input.claudeDir, sessionId);

    if (!state) {
      safeUnlink(stateFile);
      safeUnlink(eventsFile);
      safeUnlink(targetFile);
      continue;
    }

    const dead = state.pid <= 0 || !input.isAlive(state.pid);
    if (!dead) continue;

    if (state.promptOpen && state.cwd !== "") {
      const events = readEventLog(eventsFile);
      const prompts = splitPrompts(events);
      const last = prompts[prompts.length - 1];
      if (last && last.open) {
        // Close at the prompt's last recorded activity, never at recovery
        // time (which is the next session start, possibly hours later).
        // `now` is only a fallback when no usable timestamp exists.
        const lastTs = last.events[last.events.length - 1]?.ts;
        const settledAt = typeof lastTs === "number" && Number.isFinite(lastTs) ? lastTs : input.now;
        const costNow = readCost(input.env, sessionId);
        const core = replayPrompt(last, { settledAt, cost: settleCost(costNow?.totalUsd, state.promptOpen.costAtStart).cost });
        if (core) {
          const model = costNow?.model;
          records.push(buildClaudeRecord(core, state, sessionId, model, input.resolveAssignment?.(state.cwd, sessionId)));
        }
      }
    }

    safeUnlink(stateFile);
    safeUnlink(eventsFile);
    safeUnlink(targetFile);
    deleteCost(input.env, sessionId);
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
