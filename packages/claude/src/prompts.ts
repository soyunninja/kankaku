import type { Event } from "./events.ts";

export interface PromptEvents {
  events: Event[];
  /** `false` once the prompt's terminal Stop has been seen; `true` while it is still in progress or was interrupted. */
  open: boolean;
}

/**
 * Groups a session's event stream into prompts: each group starts at a
 * `UserPromptSubmit` and collects every following event up to (and
 * including) the next `UserPromptSubmit`. A group is closed (`open: false`)
 * only when its last event is a `Stop` — a Stop followed by more events (a
 * Stop-hook-continued turn) leaves the group open until a later Stop
 * actually terminates it, or forever if it never does (interrupted).
 * Leading events before any `UserPromptSubmit` are ignored.
 */
export function splitPrompts(events: Event[]): PromptEvents[] {
  const prompts: PromptEvents[] = [];
  let current: Event[] | undefined;

  for (const event of events) {
    if (event.event === "UserPromptSubmit") {
      if (current) {
        prompts.push({ events: current, open: isOpen(current) });
      }
      current = [event];
      continue;
    }
    if (!current) continue; // orphan event before any UserPromptSubmit
    current.push(event);
  }
  if (current) {
    prompts.push({ events: current, open: isOpen(current) });
  }
  return prompts;
}

function isOpen(events: Event[]): boolean {
  const last = events[events.length - 1];
  return last === undefined || last.event !== "Stop";
}
