import { randomUUID } from "node:crypto";
import type { Clock } from "../ports/clock.ts";
import { clampIntervals, unionMs } from "./intervals.ts";
import { emptyUsage, WORK_RECORD_SCHEMA } from "./work-record.ts";
import type { SubagentSpan, UsageTotals, WorkRecordCore, WorkStatus } from "./work-record.ts";
import type { SegmentRule } from "./segment-rule.ts";

export interface WorkTrackerOptions {
  clock: Clock;
  interactiveTools: string[];
  subagentTool: string;
  /** Rules that tag a tool execution's span under a named segment. Defaults to none. */
  segmentRules?: SegmentRule[];
}

interface Interval {
  start: number;
  end: number | undefined;
}

interface OpenSubagentSpan {
  toolCallId: string;
  agent: string;
  mode: string;
  start: number;
}

interface RunState {
  startedAt: number;
  prompt: string;
  runs: number;
  turns: number;
  tools: Record<string, number>;
  usage: UsageTotals;
  status: WorkStatus;
  waitingSpans: Interval[];
  /** Waiting spans opened by interactive tools, keyed by tool call id. */
  openToolWaits: Map<string, Interval>;
  subagents: SubagentSpan[];
  openSubagents: Map<string, OpenSubagentSpan>;
  /** Segment spans opened by a matching {@link SegmentRule}, keyed by tag. */
  segmentSpans: Record<string, Interval[]>;
  /** The still-open segment span for a tool call id, if any. */
  openSegments: Map<string, Interval>;
}

interface RunEndMessage {
  role: string;
  stopReason?: string;
}

/**
 * Pure domain state machine that turns pi lifecycle events into finished
 * {@link WorkRecord} entries. Holds no I/O; timestamps come from the
 * injected {@link Clock} so behaviour is deterministic under test.
 */
export class WorkTracker {
  private readonly clock: Clock;
  private readonly interactiveTools: Set<string>;
  private readonly subagentTool: string;
  private readonly segmentRules: SegmentRule[];
  private state: RunState | undefined;

  constructor(options: WorkTrackerOptions) {
    this.clock = options.clock;
    this.interactiveTools = new Set(options.interactiveTools);
    this.subagentTool = options.subagentTool;
    this.segmentRules = options.segmentRules ?? [];
  }

  onRunStart(prompt: string): void {
    if (!this.state) {
      this.state = {
        startedAt: this.clock.now(),
        prompt,
        runs: 1,
        turns: 0,
        tools: {},
        usage: emptyUsage(),
        status: "completed",
        waitingSpans: [],
        openToolWaits: new Map(),
        subagents: [],
        openSubagents: new Map(),
        segmentSpans: {},
        openSegments: new Map(),
      };
      return;
    }
    this.state.runs++;
  }

  onTurnEnd(usage: Partial<UsageTotals> | undefined): void {
    if (!this.state) return;
    this.state.turns++;
    if (!usage) return;
    this.state.usage.input += usage.input ?? 0;
    this.state.usage.output += usage.output ?? 0;
    this.state.usage.cacheRead += usage.cacheRead ?? 0;
    this.state.usage.cacheWrite += usage.cacheWrite ?? 0;
    this.state.usage.cost += usage.cost ?? 0;
  }

  onToolStart(toolCallId: string, toolName: string, args: Record<string, unknown> | undefined): void {
    if (!this.state) return;
    this.state.tools[toolName] = (this.state.tools[toolName] ?? 0) + 1;

    const rule = this.segmentRules.find((candidate) => candidate.tool === toolName && candidate.pattern.test(segmentText(args)));
    if (rule) {
      const span: Interval = { start: this.clock.now(), end: undefined };
      const spans = this.state.segmentSpans[rule.tag] ?? (this.state.segmentSpans[rule.tag] = []);
      spans.push(span);
      this.state.openSegments.set(toolCallId, span);
    }

    if (this.interactiveTools.has(toolName)) {
      const span: Interval = { start: this.clock.now(), end: undefined };
      this.state.waitingSpans.push(span);
      this.state.openToolWaits.set(toolCallId, span);
      return;
    }

    if (toolName === this.subagentTool) {
      const agent = typeof args?.["agent"] === "string" ? (args["agent"] as string) : "unknown";
      const mode = typeof args?.["mode"] === "string" ? (args["mode"] as string) : "task";
      this.state.openSubagents.set(toolCallId, {
        toolCallId,
        agent,
        mode,
        start: this.clock.now(),
      });
    }
  }

  onToolEnd(toolCallId: string, result: unknown): void {
    if (!this.state) return;

    const openSegment = this.state.openSegments.get(toolCallId);
    if (openSegment) {
      this.state.openSegments.delete(toolCallId);
      openSegment.end = this.clock.now();
    }

    const openSubagent = this.state.openSubagents.get(toolCallId);
    if (openSubagent) {
      this.state.openSubagents.delete(toolCallId);
      const taskId = extractTaskId(result);
      this.state.subagents.push({
        toolCallId: openSubagent.toolCallId,
        agent: openSubagent.agent,
        mode: openSubagent.mode,
        ...(taskId !== undefined ? { taskId } : {}),
        ms: this.clock.now() - openSubagent.start,
      });
      return;
    }

    const openWaitingSpan = this.state.openToolWaits.get(toolCallId);
    if (openWaitingSpan) {
      this.state.openToolWaits.delete(toolCallId);
      openWaitingSpan.end = this.clock.now();
    }
  }

  onUiPromptStart(_kind: string): void {
    if (!this.state) return;
    this.state.waitingSpans.push({ start: this.clock.now(), end: undefined });
  }

  onUiPromptEnd(_kind: string): void {
    if (!this.state) return;
    // Prompts are sequential; close the most recently opened span (LIFO).
    for (let i = this.state.waitingSpans.length - 1; i >= 0; i--) {
      const span = this.state.waitingSpans[i];
      if (span && span.end === undefined) {
        span.end = this.clock.now();
        return;
      }
    }
  }

  onRunEnd(messages: RunEndMessage[]): void {
    if (!this.state) return;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") {
      this.state.status = "aborted";
    }
  }

  onSettled(): WorkRecordCore | undefined {
    if (!this.state) return undefined;
    const record = this.finalize(this.state.status);
    this.state = undefined;
    return record;
  }

  onShutdown(): WorkRecordCore | undefined {
    if (!this.state) return undefined;
    const record = this.finalize("interrupted");
    this.state = undefined;
    return record;
  }

  private finalize(status: WorkStatus): WorkRecordCore {
    const state = this.state;
    if (!state) {
      throw new Error("finalize called without an open run");
    }
    const settledAt = this.clock.now();
    const wallMs = settledAt - state.startedAt;

    for (const span of state.waitingSpans) {
      if (span.end === undefined) {
        span.end = settledAt;
      }
    }

    const closedSpans = state.waitingSpans.map((span) => ({ start: span.start, end: span.end as number }));
    const waitingMs = unionMs(clampIntervals(closedSpans, state.startedAt, settledAt));
    const workMs = wallMs - waitingMs;

    const segments: Record<string, number> = {};
    for (const [tag, spans] of Object.entries(state.segmentSpans)) {
      for (const span of spans) {
        if (span.end === undefined) {
          span.end = settledAt;
        }
      }
      const closedTagSpans = spans.map((span) => ({ start: span.start, end: span.end as number }));
      const tagMs = unionMs(clampIntervals(closedTagSpans, state.startedAt, settledAt));
      if (tagMs > 0) {
        segments[tag] = tagMs;
      }
    }

    return {
      schema: WORK_RECORD_SCHEMA,
      id: randomUUID(),
      prompt: state.prompt,
      startedAt: new Date(state.startedAt).toISOString(),
      settledAt: new Date(settledAt).toISOString(),
      wallMs,
      waitingMs,
      workMs,
      runs: state.runs,
      turns: state.turns,
      tools: state.tools,
      subagents: state.subagents,
      segments,
      usage: state.usage,
      status,
    };
  }
}

/** Text to match a {@link SegmentRule} pattern against: the `command` string arg when present, else the whole args object as JSON. */
function segmentText(args: Record<string, unknown> | undefined): string {
  const command = args?.["command"];
  return typeof command === "string" ? command : JSON.stringify(args ?? {});
}

function extractTaskId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const gentleAgents = (details as { gentleAgents?: unknown }).gentleAgents;
  if (!gentleAgents || typeof gentleAgents !== "object") return undefined;
  const taskId = (gentleAgents as { taskId?: unknown }).taskId;
  return typeof taskId === "string" ? taskId : undefined;
}
