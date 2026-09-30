import { unlinkSync } from "node:fs";
import { resolvePaths, type ResolvedPaths } from "./paths.ts";
import { appendEvent, readEventLog, dropSettledPrompts } from "./event-log.ts";
import { readState, writeState, updateState, type SessionState } from "./session-state.ts";
import { settleTranscripts, trackTranscriptAtSubmit, waitForTranscript, type SettledTranscripts } from "./transcript-settle.ts";
import { resolveClaudePid, type PsInfo } from "./claude-pid.ts";
import { splitPrompts, type PromptEvents } from "./prompts.ts";
import { readCost, deleteCost, sweepStaleCostFiles } from "./cost-store.ts";
import { settleCost } from "./cost-chain.ts";
import type { Event } from "./events.ts";
import type { WorkLog } from "kankaku-pi/ports";
import type { SyncTrigger } from "kankaku-pi/hub";
import type { ClaudeWorkTarget, ClaudeWorkTargetInput, RecordAssignment } from "./work-target.ts";

export interface HandleHookDeps {
  env: NodeJS.ProcessEnv;
  /** Epoch ms; called once per event to stamp it and drive the Stop cost wait. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Injected for tests; production defaults to `new JsonlWorkLog(kankakuDir)`. */
  log?: WorkLog;
  isAlive: (pid: number) => boolean;
  runPs: (pid: number) => PsInfo | undefined;
  stderr: (message: string) => void;
  /** Optional heavy-hook seam for tests. */
  autoSync?: (trigger: SyncTrigger) => Promise<void>;
  /**
   * Work-target seam for tests. Production resolves through
   * `resolveClaudeWorkTarget` (cache file only, no network), and only where
   * a record is built: never on the light hook path.
   */
  resolveTarget?: (input: ClaudeWorkTargetInput) => ClaudeWorkTarget;
}

/** The transcript `entrypoint` of a headless `claude -p` run. */
const HEADLESS_ENTRYPOINT = "sdk-cli";

const STOP_COST_WAIT_POLL_MS = 100;
const STOP_COST_WAIT_MAX_MS = 1500;

/**
 * Dispatches one Claude Code hook invocation. Light events (everything but
 * Stop/SessionStart/SessionEnd) only append one event line plus a tiny
 * state update, and never import `kankaku-pi` at runtime — the heavier replay/
 * storage layer is loaded with dynamic `import()` only inside the three
 * branches that actually settle or recover a record.
 */
export async function handleHook(input: unknown, deps: HandleHookDeps): Promise<void> {
  const common = parseCommon(input);
  if (!common) {
    deps.stderr("kankaku: malformed hook input, ignoring");
    return;
  }
  const { sessionId, cwd, hookEventName, raw } = common;
  const paths = resolvePaths({ env: deps.env, cwd, sessionId });
  const ts = deps.now();

  switch (hookEventName) {
    case "UserPromptSubmit": {
      const prompt = readString(raw.prompt) ?? "";
      const promptId = readString(raw.prompt_id);
      const event: Event = promptId
        ? { ts, event: "UserPromptSubmit", prompt, promptId }
        : { ts, event: "UserPromptSubmit", prompt };
      appendEvent(paths.eventsFile, event);
      const snapshot = readCost(deps.env, sessionId)?.totalUsd;
      const transcriptPath = readString(raw.transcript_path);
      updateState(paths.stateFile, (state) => ({
        pid: state?.pid ?? 0,
        parentPid: state?.parentPid ?? 0,
        cwd: state?.cwd || cwd,
        startedAt: state?.startedAt ?? ts,
        // The chained baseline wins over the snapshot: spend since the last settle belongs to this prompt.
        promptOpen: { id: promptId ?? `${sessionId}:${ts}`, startedAt: ts, costAtStart: state?.costBaseline ?? snapshot },
        permissionOpen: null,
        ...carriedOver(state),
        // Stat only: the transcript's content is read at settle, never here.
        ...withTranscript(trackTranscriptSafely(state, transcriptPath)),
      }));
      return;
    }
    case "PreToolUse": {
      const toolUseId = readString(raw.tool_use_id) ?? "";
      const toolName = readString(raw.tool_name) ?? "";
      const toolInput = isPlainObject(raw.tool_input) ? raw.tool_input : {};
      appendEvent(paths.eventsFile, { ts, event: "PreToolUse", toolUseId, toolName, toolInput });
      clearPermissionOpen(paths.stateFile);
      return;
    }
    case "PostToolUse": {
      const toolUseId = readString(raw.tool_use_id) ?? "";
      const toolName = readString(raw.tool_name) ?? "";
      appendEvent(paths.eventsFile, { ts, event: "PostToolUse", toolUseId, toolName });
      clearPermissionOpen(paths.stateFile);
      return;
    }
    case "PermissionRequest": {
      const toolUseId = readString(raw.tool_use_id) ?? "";
      const toolName = readString(raw.tool_name) ?? "";
      appendEvent(paths.eventsFile, { ts, event: "PermissionRequest", toolUseId, toolName });
      updateState(paths.stateFile, (state) => ({
        pid: state?.pid ?? 0,
        parentPid: state?.parentPid ?? 0,
        cwd: state?.cwd || cwd,
        startedAt: state?.startedAt ?? ts,
        promptOpen: state?.promptOpen ?? null,
        permissionOpen: ts,
        ...carriedOver(state),
      }));
      return;
    }
    case "SubagentStart": {
      const agentId = readString(raw.agent_id) ?? "";
      const agentType = readString(raw.agent_type) ?? "";
      appendEvent(paths.eventsFile, { ts, event: "SubagentStart", agentId, agentType });
      clearPermissionOpen(paths.stateFile);
      return;
    }
    case "SubagentStop": {
      const agentId = readString(raw.agent_id) ?? "";
      const agentType = readString(raw.agent_type) ?? "";
      appendEvent(paths.eventsFile, { ts, event: "SubagentStop", agentId, agentType });
      clearPermissionOpen(paths.stateFile);
      return;
    }
    case "Stop": {
      const stopHookActive = raw.stop_hook_active === true;
      appendEvent(paths.eventsFile, { ts, event: "Stop", stopHookActive });
      clearPermissionOpen(paths.stateFile);
      await handleStop(paths, sessionId, deps, ts);
      return;
    }
    case "SessionStart": {
      const source = readString(raw.source) ?? "startup";
      appendEvent(paths.eventsFile, { ts, event: "SessionStart", source });
      await handleSessionStart(paths, sessionId, cwd, source, raw.source === "startup", ts, deps);
      return;
    }
    case "SessionEnd": {
      const reason = readString(raw.reason) ?? "other";
      appendEvent(paths.eventsFile, { ts, event: "SessionEnd", reason });
      await handleSessionEnd(paths, sessionId, cwd, ts, deps);
      return;
    }
    default:
      return;
  }
}

/** `startedAt` is when the hook process started: the transcript wait is measured from it. */
async function handleStop(paths: ResolvedPaths, sessionId: string, deps: HandleHookDeps, startedAt: number): Promise<void> {
  const { replayPrompt } = await import("./replay.ts");
  const { buildClaudeRecord, stampTokens } = await import("./record.ts");
  const { JsonlWorkLog } = await import("kankaku-pi/hub");

  const events = readEventLog(paths.eventsFile);
  const beforeStopTs = events.length >= 2 ? events[events.length - 2]!.ts : events[events.length - 1]?.ts ?? deps.now();

  // A headless session (`claude -p`) has no statusline: its cost comes from the transcript at SessionEnd,
  // so the statusline wait is pointless. The entry point is known after the first settle; before that, peek.
  const opened = readState(paths.stateFile);
  const entrypoint = opened?.transcript?.entrypoint ?? (opened?.promptOpen ? settleSafely(opened, deps)?.transcript.entrypoint : undefined);
  const skipCostWait = entrypoint === HEADLESS_ENTRYPOINT;

  const deadline = deps.now() + STOP_COST_WAIT_MAX_MS;
  let cost = readCost(deps.env, sessionId);
  while (!skipCostWait && (!cost || cost.updatedAt < beforeStopTs) && deps.now() < deadline) {
    await deps.sleep(STOP_COST_WAIT_POLL_MS);
    cost = readCost(deps.env, sessionId);
  }

  // Claude Code writes the transcript asynchronously: give the last assistant lines a bounded moment to land.
  if (opened?.promptOpen) await waitForTranscript(opened.transcript, deps, startedAt).catch(() => {});
  const state = readState(paths.stateFile);
  const transcript = state?.promptOpen ? settleSafely(state, deps) : undefined;
  const headless = transcript?.transcript.entrypoint === HEADLESS_ENTRYPOINT;

  const prompts = splitPrompts(events);
  const last: PromptEvents | undefined = prompts[prompts.length - 1];
  if (!last || !state) {
    if (!state) deps.stderr(`kankaku: no session state at Stop for ${sessionId}`);
    return;
  }

  if (headless && state.promptOpen) {
    // Times, waiting and tokens are final; the cost is not known until SessionEnd. Keep the prompt and write nothing.
    const core = replayPrompt(last, {});
    const pending = [...(state.pending ?? [])];
    if (core) pending.push({ core: stampTokens(core, transcript?.tokens), costAtStart: state.promptOpen.costAtStart });
    writeState(paths.stateFile, {
      ...state,
      promptOpen: null,
      permissionOpen: null,
      ...withTranscript(transcript?.transcript),
      pending,
    });
    dropSettledPrompts(paths.eventsFile, events.slice(0, events.length - last.events.length));
    return;
  }

  // A Stop with no open prompt settles nothing: no cost, no baseline move.
  const settled = state.promptOpen ? settleCost(cost?.totalUsd, state.promptOpen.costAtStart) : {};

  const core = replayPrompt(last, { cost: settled.cost });
  if (core) {
    const assignment = await assignmentResolver(paths, deps);
    const version = agentVersionOf(transcript, state);
    const record = buildClaudeRecord(stampTokens(core, transcript?.tokens), state, sessionId, cost?.model ?? modelOf(transcript, state), assignment(state.cwd, sessionId), {
      ...(version !== undefined ? { agentVersion: version } : {}),
    });
    const log = deps.log ?? new JsonlWorkLog(paths.kankakuDir);
    log.append(record);
  }

  writeState(paths.stateFile, {
    ...state,
    promptOpen: null,
    permissionOpen: null,
    ...(settled.baseline !== undefined ? { costBaseline: settled.baseline } : {}),
    ...withTranscript(transcript?.transcript),
  });
  const keep = events.slice(0, events.length - last.events.length);
  dropSettledPrompts(paths.eventsFile, keep);
  if (core) await syncHeavy("agent_settled", state.cwd, deps);
}

async function handleSessionStart(
  paths: ResolvedPaths,
  sessionId: string,
  cwd: string,
  source: string,
  isStartup: boolean,
  ts: number,
  deps: HandleHookDeps,
): Promise<void> {
  if (source !== "compact") {
    const { recoverStaleSessions } = await import("./inflight-recovery.ts");
    const { JsonlWorkLog } = await import("kankaku-pi/hub");
    const recovered = recoverStaleSessions({
      claudeDir: paths.claudeDir,
      currentSessionId: sessionId,
      isAlive: deps.isAlive,
      now: deps.now(),
      env: deps.env,
      resolveAssignment: await assignmentResolver(paths, deps),
    });
    if (recovered.length > 0) {
      const log = deps.log ?? new JsonlWorkLog(paths.kankakuDir);
      for (const record of recovered) log.append(record);
    }
    sweepStaleCostFiles(deps.env, { now: deps.now() });
  }

  const existing = readState(paths.stateFile);
  if (existing) {
    await syncHeavy("session_start", cwd, deps);
    return; // resume/fork on an existing state: keep it as-is
  }

  const pid = resolveClaudePid({ startPid: process.ppid, runPs: deps.runPs });
  const resolvedInfo = deps.runPs(pid);
  const parentPid = resolvedInfo?.ppid ?? process.ppid;

  const state: SessionState = {
    pid,
    parentPid,
    cwd,
    startedAt: ts,
    promptOpen: null,
    permissionOpen: null,
    // A newly started session's counter starts at zero; any other source keeps the snapshot-at-submit fallback.
    ...(isStartup ? { costBaseline: 0 } : {}),
  };
  writeState(paths.stateFile, state);
  await syncHeavy("session_start", cwd, deps);
}

async function handleSessionEnd(paths: ResolvedPaths, sessionId: string, cwd: string, ts: number, deps: HandleHookDeps): Promise<void> {
  const state = readState(paths.stateFile);
  if (state && (state.promptOpen || (state.pending?.length ?? 0) > 0)) {
    const { replayPrompt } = await import("./replay.ts");
    const { buildClaudeRecord, stampTokens } = await import("./record.ts");
    const { JsonlWorkLog } = await import("kankaku-pi/hub");
    const log = deps.log ?? new JsonlWorkLog(paths.kankakuDir);
    const assignment = await assignmentResolver(paths, deps);
    // Also the only place the cost-state of a headless run is visible: it is written after the last Stop.
    const transcript = settleSafely(state, deps);
    const version = agentVersionOf(transcript, state);
    const headless = (state.pending?.length ?? 0) > 0 || transcript?.transcript.entrypoint === HEADLESS_ENTRYPOINT;
    let pending = [...(state.pending ?? [])];
    let attached = false;

    if (state.promptOpen) {
      const events = readEventLog(paths.eventsFile);
      const last = splitPrompts(events).at(-1);
      if (last) {
        const costNow = readCost(deps.env, sessionId);
        const settled = headless ? {} : settleCost(costNow?.totalUsd, state.promptOpen.costAtStart);
        const core = replayPrompt(last, { settledAt: ts, cost: settled.cost });
        if (core && headless) {
          pending.push({ core: stampTokens(core, transcript?.tokens), costAtStart: state.promptOpen.costAtStart });
          attached = true;
        } else if (core) {
          const record = buildClaudeRecord(stampTokens(core, transcript?.tokens), state, sessionId, costNow?.model ?? modelOf(transcript, state), assignment(state.cwd, sessionId), {
            ...(version !== undefined ? { agentVersion: version } : {}),
          });
          log.append(record);
        }
      }
    }

    if (headless && pending.length > 0) {
      const { buildHeadlessRecords, withLateTokens } = await import("./headless.ts");
      // Lines written after the prompt settled belong to the prompt that just settled: the last one.
      if (!attached) pending = withLateTokens(pending, transcript?.tokens);
      const model = modelOf(transcript, state);
      const records = buildHeadlessRecords({
        pending,
        ...(model !== undefined ? { model } : {}),
        state,
        sessionId,
        ...(transcript?.costState !== undefined ? { costState: transcript.costState } : {}),
        assignment: assignment(state.cwd, sessionId),
        ...(version !== undefined ? { agentVersion: version } : {}),
      });
      for (const record of records) log.append(record);
      // Written once, whichever path gets there first: drop the pending list before anything slow runs.
      const { pending: _written, ...withoutPending } = state;
      writeState(paths.stateFile, { ...withoutPending, promptOpen: null, permissionOpen: null });
    }
  }
  try {
    await syncHeavy("session_shutdown", state?.cwd ?? cwd, deps);
  } finally {
    deleteSessionFiles(paths);
    deleteCost(deps.env, sessionId);
  }
}

/**
 * Loads the work-target resolver (a heavy module) and returns a per-cwd
 * lookup that never throws: any failure means "no assignment", exactly the
 * unassigned behaviour. Heavy hooks only.
 */
async function assignmentResolver(
  paths: ResolvedPaths,
  deps: HandleHookDeps,
): Promise<(cwd: string, sessionId: string) => RecordAssignment> {
  try {
    const { resolveClaudeWorkTarget } = await import("./work-target.ts");
    const { homedir } = await import("node:os");
    const { readSessionTarget, sessionInputs } = await import("./session-target-store.ts");
    const { resolveTargetFile } = await import("./paths.ts");
    const resolve = deps.resolveTarget ?? resolveClaudeWorkTarget;
    return (cwd, sessionId) => {
      try {
        // The session-only target and task link (`/kankaku:target`, `/kankaku:task`); heavy hooks only.
        const stored = readSessionTarget(resolveTargetFile(paths.claudeDir, sessionId));
        const { target, legacyClient } = resolve({
          cwd,
          kankakuDir: paths.kankakuDir,
          homeDir: deps.env.HOME || homedir(),
          env: deps.env,
          ...(stored !== undefined ? sessionInputs(stored) : {}),
        });
        return {
          ...(target !== undefined ? { target } : {}),
          ...(legacyClient !== undefined ? { legacyClient } : {}),
        };
      } catch (error) {
        deps.stderr(`kankaku: work target: ${error instanceof Error ? error.message : String(error)}`);
        return {};
      }
    };
  } catch {
    return () => ({});
  }
}

async function syncHeavy(trigger: SyncTrigger, cwd: string, deps: HandleHookDeps): Promise<void> {
  try {
    if (deps.autoSync) await deps.autoSync(trigger);
    else {
      const { autoSync } = await import("./auto-sync.ts");
      await autoSync(trigger, { env: deps.env, cwd, now: deps.now, stderr: deps.stderr });
    }
  } catch (error) {
    deps.stderr(`kankaku auto-sync: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Everything that survives a state rewrite besides the fields the handler sets itself. */
function carriedOver(state: SessionState | undefined): Pick<SessionState, "costBaseline" | "transcript" | "pending"> {
  return {
    ...(state?.costBaseline !== undefined ? { costBaseline: state.costBaseline } : {}),
    ...(state?.transcript !== undefined ? { transcript: state.transcript } : {}),
    ...(state?.pending !== undefined ? { pending: state.pending } : {}),
  };
}

function withTranscript(transcript: SessionState["transcript"]): Pick<SessionState, "transcript"> {
  return transcript !== undefined ? { transcript } : {};
}

/** The transcript bookkeeping never fails a hook: on any error the state keeps what it had. */
function trackTranscriptSafely(state: SessionState | undefined, path: string | undefined): SessionState["transcript"] {
  try {
    return trackTranscriptAtSubmit(state?.transcript, path);
  } catch {
    return state?.transcript;
  }
}

/** Reads what the transcript gained since the stored positions; any failure means "no tokens", as before this feature. */
function settleSafely(state: SessionState, deps: HandleHookDeps): SettledTranscripts | undefined {
  try {
    return settleTranscripts(state.transcript);
  } catch (error) {
    deps.stderr(`kankaku: transcript: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function modelOf(settled: SettledTranscripts | undefined, state: SessionState): string | undefined {
  return settled?.transcript.model ?? state.transcript?.model;
}

function agentVersionOf(settled: SettledTranscripts | undefined, state: SessionState): string | undefined {
  return settled?.transcript.agentVersion ?? state.transcript?.agentVersion;
}

function deleteSessionFiles(paths: ResolvedPaths): void {
  for (const file of [paths.stateFile, paths.eventsFile, paths.targetFile]) {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
}

function clearPermissionOpen(stateFile: string): void {
  const state = readState(stateFile);
  if (!state || state.permissionOpen === null) return;
  writeState(stateFile, { ...state, permissionOpen: null });
}

interface CommonHookFields {
  sessionId: string;
  cwd: string;
  hookEventName: string;
  raw: Record<string, unknown>;
}

function parseCommon(input: unknown): CommonHookFields | undefined {
  if (!isPlainObject(input)) return undefined;
  const sessionId = readString(input.session_id);
  const cwd = readString(input.cwd);
  const hookEventName = readString(input.hook_event_name);
  if (!sessionId || !cwd || !hookEventName) return undefined;
  return { sessionId, cwd, hookEventName, raw: input };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
