import type { WorkRecord, WorkRecordCore } from "kankaku/domain";
import type { SessionState } from "./session-state.ts";

/**
 * Attaches the orchestrator metadata a replayed {@link WorkRecordCore}
 * needs to become a persistable {@link WorkRecord}. Phase 1: no
 * `client`/`clientId` (hub sync is phase 2). `model` is the statusline
 * model id (from `src/cost-store.ts#readCost`, since T7 no longer a field
 * of `SessionState`) — passed in explicitly rather than read here, so the
 * caller decides which cost snapshot's model applies.
 */
export function buildClaudeRecord(
  core: WorkRecordCore,
  state: SessionState,
  sessionId: string,
  model: string | undefined,
): WorkRecord {
  return {
    ...core,
    role: "orchestrator",
    pid: state.pid,
    parentPid: state.parentPid,
    project: state.cwd,
    sessionId,
    mode: "claude-code",
    ...(model ? { model: `anthropic/${model}` } : {}),
  };
}
