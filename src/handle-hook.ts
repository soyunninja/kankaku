import { unlinkSync } from "node:fs";
import { resolvePaths, type ResolvedPaths } from "./paths.ts";
import { appendEvent, readEventLog, dropSettledPrompts } from "./event-log.ts";
import { readState, writeState, updateState, type SessionState } from "./session-state.ts";
import { resolveClaudePid, type PsInfo } from "./claude-pid.ts";
import { splitPrompts, type PromptEvents } from "./replay.ts";
import type { Event } from "./events.ts";
import type { WorkLog } from "kankaku/ports";

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
}

const STOP_COST_WAIT_POLL_MS = 100;
const STOP_COST_WAIT_MAX_MS = 1500;

/**
 * Dispatches one Claude Code hook invocation. Light events (everything but
 * Stop/SessionStart/SessionEnd) only append one event line plus a tiny
 * state update, and never import `kankaku` at runtime — the heavier replay/
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
      updateState(paths.stateFile, (state) => ({
        pid: state?.pid ?? 0,
        parentPid: state?.parentPid ?? 0,
        cwd: state?.cwd || cwd,
        startedAt: state?.startedAt ?? ts,
        cost: state?.cost ?? null,
        promptOpen: { id: promptId ?? `${sessionId}:${ts}`, startedAt: ts, costAtStart: state?.cost?.totalUsd },
        permissionOpen: null,
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
        cost: state?.cost ?? null,
        permissionOpen: ts,
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
      await handleStop(paths, sessionId, deps);
      return;
    }
    case "SessionStart": {
      const source = readString(raw.source) ?? "startup";
      appendEvent(paths.eventsFile, { ts, event: "SessionStart", source });
      await handleSessionStart(paths, sessionId, cwd, source, ts, deps);
      return;
    }
    case "SessionEnd": {
      const reason = readString(raw.reason) ?? "other";
      appendEvent(paths.eventsFile, { ts, event: "SessionEnd", reason });
      await handleSessionEnd(paths, sessionId, ts, deps);
      return;
    }
    default:
      return;
  }
}

async function handleStop(paths: ResolvedPaths, sessionId: string, deps: HandleHookDeps): Promise<void> {
  const { replayPrompt } = await import("./replay.ts");
  const { buildClaudeRecord } = await import("./record.ts");
  const { JsonlWorkLog } = await import("kankaku/hub");

  const events = readEventLog(paths.eventsFile);
  const beforeStopTs = events.length >= 2 ? events[events.length - 2]!.ts : events[events.length - 1]?.ts ?? deps.now();

  const deadline = deps.now() + STOP_COST_WAIT_MAX_MS;
  let state = readState(paths.stateFile);
  while ((!state?.cost || state.cost.updatedAt < beforeStopTs) && deps.now() < deadline) {
    await deps.sleep(STOP_COST_WAIT_POLL_MS);
    state = readState(paths.stateFile);
  }

  const prompts = splitPrompts(events);
  const last: PromptEvents | undefined = prompts[prompts.length - 1];
  if (!last || !state) {
    if (!state) deps.stderr(`kankaku: no session state at Stop for ${sessionId}`);
    return;
  }

  const costAtStart = state.promptOpen?.costAtStart;
  const totalUsd = state.cost?.totalUsd;
  const cost =
    typeof costAtStart === "number" && typeof totalUsd === "number"
      ? Math.max(0, totalUsd - costAtStart)
      : undefined;

  const core = replayPrompt(last, { cost });
  if (core) {
    const record = buildClaudeRecord(core, state, sessionId);
    const log = deps.log ?? new JsonlWorkLog(paths.kankakuDir);
    log.append(record);
  }

  writeState(paths.stateFile, { ...state, promptOpen: null, permissionOpen: null });
  const keep = events.slice(0, events.length - last.events.length);
  dropSettledPrompts(paths.eventsFile, keep);
}

async function handleSessionStart(
  paths: ResolvedPaths,
  sessionId: string,
  cwd: string,
  source: string,
  ts: number,
  deps: HandleHookDeps,
): Promise<void> {
  if (source !== "compact") {
    const { recoverStaleSessions } = await import("./inflight-recovery.ts");
    const { JsonlWorkLog } = await import("kankaku/hub");
    const recovered = recoverStaleSessions({
      claudeDir: paths.claudeDir,
      currentSessionId: sessionId,
      isAlive: deps.isAlive,
      now: deps.now(),
    });
    if (recovered.length > 0) {
      const log = deps.log ?? new JsonlWorkLog(paths.kankakuDir);
      for (const record of recovered) log.append(record);
    }
  }

  const existing = readState(paths.stateFile);
  if (existing) return; // resume/fork on an existing state: keep it as-is

  const pid = resolveClaudePid({ startPid: process.ppid, runPs: deps.runPs });
  const resolvedInfo = deps.runPs(pid);
  const parentPid = resolvedInfo?.ppid ?? process.ppid;

  const state: SessionState = {
    pid,
    parentPid,
    cwd,
    startedAt: ts,
    promptOpen: null,
    cost: null,
    permissionOpen: null,
  };
  writeState(paths.stateFile, state);
}

async function handleSessionEnd(paths: ResolvedPaths, sessionId: string, ts: number, deps: HandleHookDeps): Promise<void> {
  const state = readState(paths.stateFile);
  if (state?.promptOpen) {
    const { replayPrompt } = await import("./replay.ts");
    const { buildClaudeRecord } = await import("./record.ts");
    const { JsonlWorkLog } = await import("kankaku/hub");
    const events = readEventLog(paths.eventsFile);
    const prompts = splitPrompts(events);
    const last = prompts[prompts.length - 1];
    if (last) {
      const core = replayPrompt(last, { settledAt: ts });
      if (core) {
        const record = buildClaudeRecord(core, state, sessionId);
        const log = deps.log ?? new JsonlWorkLog(paths.kankakuDir);
        log.append(record);
      }
    }
  }
  deleteSessionFiles(paths);
}

function deleteSessionFiles(paths: ResolvedPaths): void {
  for (const file of [paths.stateFile, paths.eventsFile]) {
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
