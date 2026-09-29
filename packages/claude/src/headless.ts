import type { WorkRecord } from "kankaku-pi/domain";
import { settleCost } from "./cost-chain.ts";
import { buildClaudeRecord } from "./record.ts";
import type { PendingPrompt, SessionState } from "./session-state.ts";
import type { TranscriptCostState } from "./transcript.ts";
import type { RecordAssignment } from "./work-target.ts";

/**
 * Headless (`claude -p`, entry point `sdk-cli`) sessions have no statusline,
 * so no per-prompt cost. Their transcript gains a `cost-state` line only
 * after the last `Stop`, so the prompts are held as pending at `Stop` and
 * turned into records here, at `SessionEnd` or in crash recovery. Heavy
 * path only (imports `record.ts`).
 */

const MICRO = 1e6;

/**
 * Splits `totalUsd` over prompts in proportion to `weights`, in whole
 * micro-dollars; the rounding remainder goes to the last share so the shares
 * add up to the total exactly. All weights zero: equal shares. Exact for any
 * weight size (integer arithmetic).
 */
export function allocateCost(totalUsd: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const total = BigInt(Math.round(Math.max(0, totalUsd) * MICRO));
  let parts = weights.map((weight) => BigInt(Number.isFinite(weight) && weight > 0 ? Math.round(weight) : 0));
  if (parts.every((part) => part === 0n)) parts = parts.map(() => 1n);
  const sum = parts.reduce((a, b) => a + b, 0n);

  const shares: bigint[] = [];
  let given = 0n;
  for (let i = 0; i < parts.length - 1; i++) {
    const share = (total * parts[i]!) / sum;
    shares.push(share);
    given += share;
  }
  shares.push(total - given);
  return shares.map((share) => Number(share) / MICRO);
}

function totalTokens(prompt: PendingPrompt): number {
  const { input, output, cacheRead, cacheWrite } = prompt.core.usage;
  return [input, output, cacheRead, cacheWrite].reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
}

export interface HeadlessRecordsInput {
  pending: PendingPrompt[];
  state: SessionState;
  sessionId: string;
  /** The last `cost-state` of the session transcript, when it has one. */
  costState?: TranscriptCostState;
  assignment?: RecordAssignment;
  agentVersion?: string;
}

/**
 * The records of a finished headless session. The session cost is the
 * `cost-state` total put through the chained baseline (`settleCost`, from the
 * first pending prompt's start); with several prompts it is shared by their
 * token totals and every record is marked `costAllocated`. Without a usable
 * `cost-state` (none, or one that flags a model with unknown pricing) the
 * records carry no cost, exactly as a session without a statusline does.
 */
export function buildHeadlessRecords(input: HeadlessRecordsInput): WorkRecord[] {
  const { pending, state, sessionId } = input;
  if (pending.length === 0) return [];

  const usable = input.costState !== undefined && !input.costState.hasUnknownModelCost;
  const sessionCost = usable ? settleCost(input.costState!.totalUsd, pending[0]!.costAtStart).cost : undefined;
  const allocated = pending.length > 1;
  const costs = sessionCost === undefined ? undefined : allocated ? allocateCost(sessionCost, pending.map(totalTokens)) : [sessionCost];

  return pending.map((prompt, index) => {
    const cost = costs?.[index];
    const core = cost === undefined ? prompt.core : { ...prompt.core, usage: { ...prompt.core.usage, cost }, costObserved: true as const };
    return buildClaudeRecord(core, state, sessionId, undefined, input.assignment, {
      ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
      ...(cost !== undefined && allocated ? { costAllocated: true as const } : {}),
    });
  });
}
