import { randomUUID } from "node:crypto";
import type { Clock } from "../ports/clock.ts";
import { clampIntervals, unionMs } from "./intervals.ts";
import { emptyUsage, finiteOrZero, WORK_RECORD_SCHEMA } from "./work-record.ts";
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
  /** Generated once when the run opens, so it stays stable across `peek` and the final `onSettled`/`onShutdown`. */
  id: string;
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
  /**
   * Segment spans opened by a matching {@link SegmentRule}, keyed by tag.
   * A `Map` rather than a plain object so a tag such as `__proto__` cannot
   * pollute the object prototype while the run is in progress.
   */
  segmentSpans: Map<string, Interval[]>;
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
        id: randomUUID(),
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
        segmentSpans: new Map(),
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
    this.state.usage.input += finiteOrZero(usage.input);
    this.state.usage.output += finiteOrZero(usage.output);
    this.state.usage.cacheRead += finiteOrZero(usage.cacheRead);
    this.state.usage.cacheWrite += finiteOrZero(usage.cacheWrite);
    this.state.usage.cost += finiteOrZero(usage.cost);
  }

  onToolStart(toolCallId: string, toolName: string, args: Record<string, unknown> | undefined): void {
    if (!this.state) return;
    this.state.tools[toolName] = (this.state.tools[toolName] ?? 0) + 1;

    const rule = this.segmentRules.find((candidate) => candidate.tool === toolName && candidate.pattern.test(segmentText(args)));
    if (rule) {
      const span: Interval = { start: this.clock.now(), end: undefined };
      const spans = this.state.segmentSpans.get(rule.tag) ?? [];
      spans.push(span);
      this.state.segmentSpans.set(rule.tag, spans);
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
        // Clamped to >= 0: a backward clock jump while the subagent was
        // running must never produce a negative duration.
        ms: Math.max(0, this.clock.now() - openSubagent.start),
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
    const record = this.buildRecord(this.state.status, this.clock.now());
    this.state = undefined;
    return record;
  }

  onShutdown(): WorkRecordCore | undefined {
    if (!this.state) return undefined;
    const record = this.buildRecord("interrupted", this.clock.now());
    this.state = undefined;
    return record;
  }

  /**
   * Returns what {@link onSettled}/{@link onShutdown} would produce right
   * now, without mutating any state: open spans are truncated only in the
   * returned snapshot, so the tracker keeps running unaffected and a later
   * `peek` or the eventual settle still sees the spans' true open-ended
   * state. `undefined` when idle. The returned `id` matches the id the
   * eventual settled record will carry, since both are generated once
   * in {@link onRunStart}.
   */
  peek(status: WorkStatus): WorkRecordCore | undefined {
    if (!this.state) return undefined;
    return this.buildRecord(status, this.clock.now());
  }

  private buildRecord(status: WorkStatus, settledAt: number): WorkRecordCore {
    const state = this.state;
    if (!state) {
      throw new Error("buildRecord called without an open run");
    }
    // Clamped to >= 0: a backward clock jump (system clock adjustment, NTP
    // correction) must never produce a negative duration.
    const wallMs = Math.max(0, settledAt - state.startedAt);

    const closedSpans = state.waitingSpans.map((span) => ({ start: span.start, end: span.end ?? settledAt }));
    const waitingMs = Math.max(0, unionMs(clampIntervals(closedSpans, state.startedAt, settledAt)));
    const workMs = Math.max(0, wallMs - waitingMs);

    const segmentEntries: Array<[string, number]> = [];
    for (const [tag, spans] of state.segmentSpans) {
      const closedTagSpans = spans.map((span) => ({ start: span.start, end: span.end ?? settledAt }));
      const tagMs = Math.max(0, unionMs(clampIntervals(closedTagSpans, state.startedAt, settledAt)));
      if (tagMs > 0) {
        segmentEntries.push([tag, tagMs]);
      }
    }
    // Built via Object.fromEntries (never `segments[tag] = ...`) so a tag
    // such as `__proto__` becomes an own data property instead of silently
    // repointing the object's prototype.
    const segments = Object.fromEntries(segmentEntries);

    return {
      schema: WORK_RECORD_SCHEMA,
      id: state.id,
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
