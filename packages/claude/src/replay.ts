import { WorkTracker } from "kankaku-pi/domain";
import type { WorkRecordCore } from "kankaku-pi/domain";
import type { SubagentProfile } from "kankaku-pi/domain";
import type { Clock } from "kankaku-pi/ports";
import type { Event } from "./events.ts";

/** Tool names whose span counts as waiting rather than working. */
const INTERACTIVE_TOOLS = ["AskUserQuestion"];

/**
 * The plugin's own subagent profile: Claude Code's `Agent`/`Task` tool
 * calls open a subagent span, read from `subagent_type`. No join key is
 * offered (`SubagentStart`/`SubagentStop` are recorded but not linked, so a
 * subagent span is closed by the replay itself).
 */
const CLAUDE_CODE_SUBAGENT_PROFILE: SubagentProfile = {
  id: "claude-code",
  toolNames: ["Agent", "Task"],
  childEnvMarkers: [],
  joinKeyConfidence: "none",
  readLaunchArgs: (args) => ({
    agent: typeof args?.subagent_type === "string" ? args.subagent_type : "unknown",
    mode: "task",
  }),
  readResult: () => ({}),
};

export { splitPrompts, type PromptEvents } from "./prompts.ts";
import type { PromptEvents } from "./prompts.ts";

export interface ReplayOptions {
  /** Epoch ms to settle an open prompt at. Defaults to the last event's `ts`. */
  settledAt?: number;
  /** The prompt's cost delta (from the statusline), when known. */
  cost?: number;
}

/**
 * Feeds one prompt's events into a fresh {@link WorkTracker} and returns the
 * resulting {@link WorkRecordCore}. Pure: all timestamps come from the
 * events themselves (or `opts.settledAt`), never from the wall clock.
 */
export function replayPrompt(
  prompt: PromptEvents,
  opts: ReplayOptions = {},
): WorkRecordCore | undefined {
  if (prompt.events.length === 0) return undefined;

  let current = prompt.events[0]!.ts;
  const clock: Clock = { now: () => current };
  const tracker = new WorkTracker({
    clock,
    interactiveTools: INTERACTIVE_TOOLS,
    subagentProfiles: [CLAUDE_CODE_SUBAGENT_PROFILE],
  });

  const terminalStopIndex = prompt.open ? -1 : prompt.events.length - 1;
  let permissionOpen = false;
  let pendingAgentStart = false;
  let settled: WorkRecordCore | undefined;

  for (let i = 0; i < prompt.events.length; i++) {
    const event = prompt.events[i]!;
    current = event.ts;

    if (permissionOpen) {
      tracker.onUiPromptEnd("permission");
      permissionOpen = false;
    }
    if (pendingAgentStart) {
      tracker.onAgentStart();
      pendingAgentStart = false;
    }

    switch (event.event) {
      case "UserPromptSubmit":
        tracker.onRunStart(event.prompt);
        tracker.onAgentStart();
        break;
      case "PreToolUse":
        tracker.onToolStart(event.toolUseId, event.toolName, event.toolInput);
        break;
      case "PostToolUse":
        tracker.onToolEnd(event.toolUseId, undefined);
        break;
      case "PermissionRequest":
        tracker.onUiPromptStart("permission");
        permissionOpen = true;
        break;
      case "SubagentStart":
      case "SubagentStop":
        // Recorded on disk but not joined to any span — see the profile's
        // doc comment: no documented link between agent_id and tool_use_id.
        break;
      case "Stop":
        if (i === terminalStopIndex) {
          if (typeof opts.cost === "number" && Number.isFinite(opts.cost)) {
            tracker.onTurnEnd({ cost: opts.cost });
          } else {
            tracker.onTurnEnd(undefined);
          }
          tracker.onRunEnd([]);
          settled = tracker.onSettled();
        } else {
          // A Stop-hook-continued turn: end this run's loop now so the next
          // event's onAgentStart() opens a genuinely new run that gets
          // folded back into the same record at the terminal settle,
          // bumping `runs`.
          tracker.onRunEnd([]);
          pendingAgentStart = true;
        }
        break;
      case "SessionStart":
      case "SessionEnd":
        break;
    }
  }

  if (terminalStopIndex >= 0) return settled;

  current = opts.settledAt ?? prompt.events[prompt.events.length - 1]!.ts;
  const interrupted = tracker.onShutdown();
  if (!interrupted || typeof opts.cost !== "number" || !Number.isFinite(opts.cost)) return interrupted;
  // An interrupted prompt ends no turn, so the tracker saw no cost; stamp the
  // measured delta without inventing a turn.
  return { ...interrupted, usage: { ...interrupted.usage, cost: interrupted.usage.cost + opts.cost }, costObserved: true };
}
