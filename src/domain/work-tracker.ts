import { randomUUID } from "node:crypto";
import type { Clock } from "../ports/clock.ts";
import { clampIntervals, unionMs } from "./intervals.ts";
import { emptyUsage, EXTENSION_RUN_PROMPT, finiteOrZero, WORK_RECORD_SCHEMA } from "./work-record.ts";
import type { RunTrigger, SubagentSpan, UsageTotals, WorkRecordCore, WorkStatus } from "./work-record.ts";
import type { SegmentRule } from "./segment-rule.ts";
import { mergeAgreeingLaunchInfo, readLaunchInfo, readResultInfo, resolveToolProfile, safeAmbiguousResultInfo } from "./subagent-profile.ts";
import type { SubagentProfile } from "./subagent-profile.ts";

export interface WorkTrackerOptions {
  clock: Clock;
  interactiveTools: string[];
  /** Every active {@link SubagentProfile} (ADR 0020); a tool call opens a subagent span when its name matches any profile's `toolNames`. See `config.ts#loadConfig`. */
  subagentProfiles: SubagentProfile[];
  /** Rules that tag a tool execution's span under a named segment. Defaults to none. */
  segmentRules?: SegmentRule[];
}

interface Interval {
  start: number;
  end: number | undefined;
}

interface OpenSubagentSpan {
  toolCallId: string;
  toolName: string;
  agent: string;
  mode: string;
  /** The unambiguously-matched profile's id, or `undefined` when 0 or 2+ profiles registered this tool name (SUBAGENT-REQ-005 — never guessed). */
  profile: string | undefined;
  start: number;
}

interface RunState {
  /** Generated once when the run opens, so it stays stable across `peek` and the final `onSettled`/`onShutdown`. */
  id: string;
  startedAt: number;
  prompt: string;
  trigger?: RunTrigger;
  runs: number;
  turns: number;
  tools: Record<string, number>;
  usage: UsageTotals;
  /** `true` once any turn has reported a real (finite) provider cost figure. See `WorkRecordCore.costObserved`. */
  costObserved: boolean;
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
  private readonly subagentProfiles: SubagentProfile[];
  private readonly segmentRules: SegmentRule[];
  private state: RunState | undefined;
  /** Set by {@link onRunStart}, consumed by {@link onAgentStart}: tells a user-announced run from one an extension started. */
  private runAnnounced = false;
  /** `true` between an agent loop's start and its `agent_end`. */
  private loopActive = false;
  /**
   * The previous record, set aside because a new run began after its last
   * loop ended but BEFORE its `agent_settled` reached us. pi clears its
   * "run active" flag and only then awaits the `agent_settled` handlers, in
   * extension load order; an extension loaded earlier (gentle-pi) can start
   * the next run from its own handler. Whether that `agent_start` was a new
   * run or an `agent.continue()` of the same one is only knowable at settle
   * time — see {@link settleAll}.
   */
  private closing: { state: RunState; at: number } | undefined;

  constructor(options: WorkTrackerOptions) {
    this.clock = options.clock;
    this.interactiveTools = new Set(options.interactiveTools);
    this.subagentProfiles = options.subagentProfiles;
    this.segmentRules = options.segmentRules ?? [];
  }

  /**
   * An agent loop actually started. pi announces a USER prompt with
   * `before_agent_start` ({@link onRunStart}) and then this; a run an
   * extension starts itself (`sendCustomMessage(..., { triggerTurn: true })`,
   * how gentle-pi wakes the orchestrator when a background subagent
   * finishes) only ever produces this one. Without it that whole run — its
   * time, its cost, and the subagent spans it opens, which its children need
   * to join — was never recorded.
   */
  onAgentStart(): void {
    if (this.runAnnounced) {
      // The loop of the user prompt onRunStart just opened.
      this.runAnnounced = false;
      this.loopActive = true;
      return;
    }
    if (this.loopActive) return;
    this.openRun(EXTENSION_RUN_PROMPT, "extension");
    this.runAnnounced = false;
  }

  onRunStart(prompt: string, trigger?: RunTrigger): void {
    this.openRun(prompt, trigger);
    this.runAnnounced = true;
  }

  private openRun(prompt: string, trigger: RunTrigger | undefined): void {
    if (this.state && this.loopActive) {
      this.state.runs++;
      return;
    }
    if (this.state && !this.closing) {
      // A record is open but its last loop already ended: set it aside and
      // start a fresh one now. settleAll() decides whether that was right.
      this.closing = { state: this.state, at: this.clock.now() };
      this.state = undefined;
    }
    this.loopActive = true;
    if (this.state) {
      this.state.runs++;
      return;
    }
    this.state = {
      id: randomUUID(),
      startedAt: this.clock.now(),
      prompt,
      ...(trigger !== undefined ? { trigger } : {}),
      runs: 1,
      turns: 0,
      tools: {},
      usage: emptyUsage(),
      costObserved: false,
      status: "completed",
      waitingSpans: [],
      openToolWaits: new Map(),
      subagents: [],
      openSubagents: new Map(),
      segmentSpans: new Map(),
      openSegments: new Map(),
    };
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
    // A real, finite cost figure (even an explicit 0) counts as "measured";
    // an absent/non-finite one never un-sets a prior turn's observation.
    if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
      this.state.costObserved = true;
    }
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

    // SUBAGENT-REQ-001/005: a tool call opens a subagent span when its name
    // matches ANY active profile's toolNames — generalised from the single
    // hardcoded `subagentTool` string. `resolveToolProfile` resolves which
    // SPECIFIC profile matched (for `readLaunchInfo`/attribution) without
    // ever guessing when 2+ profiles share the same tool name (e.g.
    // "subagent", registered by both the pi reference example and
    // pi-subagents): the span still opens either way (a subagent tool call
    // genuinely happened), with `profile` left undefined. C1: when
    // genuinely ambiguous, agent/mode are read with `mergeAgreeingLaunchInfo`
    // (kept only when every candidate that reports a value agrees) instead
    // of `readLaunchInfo`'s first-defined-wins merge — this is purely
    // descriptive (never money/join-affecting), but "agreeing" is still the
    // more honest answer than silently picking one candidate's guess.
    const { profile, candidates, ambiguous } = resolveToolProfile(this.subagentProfiles, toolName);
    if (candidates.length > 0) {
      const launch = ambiguous ? mergeAgreeingLaunchInfo(candidates, args) : readLaunchInfo(candidates, args);
      this.state.openSubagents.set(toolCallId, {
        toolCallId,
        toolName,
        agent: launch.agent ?? "unknown",
        mode: launch.mode ?? "task",
        profile: profile?.id,
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
      // Consumed exactly once: a second onToolEnd for the same toolCallId
      // (should never happen from a well-behaved pi runtime) finds nothing
      // here and falls through — the guard that keeps SUBAGENT-REQ-006's
      // usage forwarding below from ever double-attributing the same call.
      this.state.openSubagents.delete(toolCallId);

      const { ambiguous, candidates } = resolveToolProfile(this.subagentProfiles, openSubagent.toolName);
      // C1 (CRITICAL fix, SUBAGENT-REQ-005/006): a genuinely ambiguous
      // match (2+ profiles registered this tool name, never told apart)
      // must never forward `usage` or `taskId` — see
      // `subagent-profile.ts#safeAmbiguousResultInfo`'s doc comment for
      // why. The unambiguous case keeps the existing best-effort merge
      // (a no-op merge when there is exactly one candidate).
      const resultInfo = ambiguous ? safeAmbiguousResultInfo(candidates, result) : readResultInfo(candidates, result);

      // SUBAGENT-REQ-006 (revised by C1): forwarded usage is recorded on
      // the SPAN itself as `forwardedUsage`, never folded into this
      // record's own `usage` totals here — `domain/task-view.ts#buildTasks`
      // (ADR 0006: aggregation across spans/children stays in exactly one
      // place) is the only place that adds it to a task's total, and only
      // for a span whose profile has no joined child record already
      // carrying this same cost through its own confirmed-marker ancestry
      // join (the writer-admitted "configured profile with both a marker
      // AND usage forwarding" hole — see `buildConfiguredProfile`'s doc
      // comment). `costObserved` is still set here, eagerly: a real cost
      // figure genuinely WAS observed by this call, whether or not this
      // specific number ends up in the final sum later.
      const usage = resultInfo.usage;
      if (usage && typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
        this.state.costObserved = true;
      }

      this.state.subagents.push({
        toolCallId: openSubagent.toolCallId,
        agent: openSubagent.agent,
        mode: openSubagent.mode,
        ...(resultInfo.taskId !== undefined ? { taskId: resultInfo.taskId } : {}),
        ...(openSubagent.profile !== undefined ? { profile: openSubagent.profile } : {}),
        // Clamped to >= 0: a backward clock jump while the subagent was
        // running must never produce a negative duration.
        ms: Math.max(0, this.clock.now() - openSubagent.start),
        ...(usage !== undefined ? { forwardedUsage: usage } : {}),
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
    this.loopActive = false;
    if (!this.state) return;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") {
      this.state.status = "aborted";
    }
  }

  /** Single-record convenience over {@link settleAll}; production code uses `settleAll`. */
  onSettled(): WorkRecordCore | undefined {
    return this.settleAll()[0];
  }

  /**
   * `agent_settled` arrived. Normally closes the one open record. When a
   * record was set aside (see {@link closing}):
   * - a loop is still running → the `agent_start` was a genuinely NEW run
   *   that overtook this settle: close only the old record, at the instant
   *   the new run began, and leave the new one open;
   * - no loop is running → it was an `agent.continue()` of the same run
   *   (retry, overflow recovery, queued message): fold it back, one record.
   *   A user-announced prompt is never folded — it keeps its own record.
   */
  settleAll(): WorkRecordCore[] {
    const now = this.clock.now();
    const closing = this.closing;
    this.closing = undefined;
    if (closing) {
      if (this.loopActive && this.state) {
        return [this.buildRecordFrom(closing.state, closing.state.status, closing.at)];
      }
      const fresh = this.state;
      this.state = undefined;
      this.runAnnounced = false;
      this.loopActive = false;
      if (!fresh) return [this.buildRecordFrom(closing.state, closing.state.status, now)];
      if (fresh.trigger === "extension") {
        return [this.buildRecordFrom(mergeRunStates(closing.state, fresh), fresh.status !== "completed" ? fresh.status : closing.state.status, now)];
      }
      return [this.buildRecordFrom(closing.state, closing.state.status, closing.at), this.buildRecordFrom(fresh, fresh.status, now)];
    }
    // Settled with nothing set aside: whatever loop we believed active is over.
    this.loopActive = false;
    if (!this.state) return [];
    const record = this.buildRecordFrom(this.state, this.state.status, now);
    this.state = undefined;
    this.runAnnounced = false;
    return [record];
  }

  /** Single-record convenience over {@link shutdownAll}. */
  onShutdown(): WorkRecordCore | undefined {
    const all = this.shutdownAll();
    return all[all.length - 1];
  }

  /** The session is going away: every open record is written, the running one as `interrupted`. */
  shutdownAll(): WorkRecordCore[] {
    const now = this.clock.now();
    const records: WorkRecordCore[] = [];
    if (this.closing) records.push(this.buildRecordFrom(this.closing.state, this.closing.state.status, this.closing.at));
    if (this.state) records.push(this.buildRecordFrom(this.state, "interrupted", now));
    this.closing = undefined;
    this.state = undefined;
    this.runAnnounced = false;
    this.loopActive = false;
    return records;
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
    // A record set aside (see `closing`) is nowhere on disk yet: fold it into
    // the snapshot so a crash before the settle cannot lose its time and
    // cost. The snapshot keeps the set-aside record's id.
    const state = this.closing ? mergeRunStates(this.closing.state, this.state) : this.state;
    return this.buildRecordFrom(state, status, this.clock.now());
  }

  private buildRecordFrom(state: RunState, status: WorkStatus, settledAt: number): WorkRecordCore {
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
      ...(state.trigger !== undefined ? { trigger: state.trigger } : {}),
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
      ...(state.costObserved ? { costObserved: true as const } : {}),
      status,
    };
  }
}

/** Text to match a {@link SegmentRule} pattern against: the `command` string arg when present, else the whole args object as JSON. */
function segmentText(args: Record<string, unknown> | undefined): string {
  const command = args?.["command"];
  return typeof command === "string" ? command : JSON.stringify(args ?? {});
}


/** Fold a continuation's counters back into the record it continued. Additive only: nothing is ever dropped. */
function mergeRunStates(base: RunState, continuation: RunState): RunState {
  const tools: Record<string, number> = { ...base.tools };
  for (const [name, count] of Object.entries(continuation.tools)) {
    tools[name] = (tools[name] ?? 0) + count;
  }
  const segmentSpans = new Map(base.segmentSpans);
  for (const [tag, spans] of continuation.segmentSpans) {
    segmentSpans.set(tag, [...(segmentSpans.get(tag) ?? []), ...spans]);
  }
  return {
    ...base,
    runs: base.runs + continuation.runs,
    turns: base.turns + continuation.turns,
    tools,
    usage: {
      input: base.usage.input + continuation.usage.input,
      output: base.usage.output + continuation.usage.output,
      cacheRead: base.usage.cacheRead + continuation.usage.cacheRead,
      cacheWrite: base.usage.cacheWrite + continuation.usage.cacheWrite,
      cost: base.usage.cost + continuation.usage.cost,
    },
    costObserved: base.costObserved || continuation.costObserved,
    waitingSpans: [...base.waitingSpans, ...continuation.waitingSpans],
    openToolWaits: new Map([...base.openToolWaits, ...continuation.openToolWaits]),
    subagents: [...base.subagents, ...continuation.subagents],
    openSubagents: new Map([...base.openSubagents, ...continuation.openSubagents]),
    segmentSpans,
    openSegments: new Map([...base.openSegments, ...continuation.openSegments]),
  };
}
