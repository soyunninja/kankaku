/**
 * The Dashboard screen's `[ Quick actions ]` panel: four fixed actions
 * (`c` refresh the catalog, `s` sync every project, `S` full-sync every
 * project, `r` reload the dashboard model) plus a status line describing
 * what is running, what just finished, or why the panel is unavailable.
 * Pure: no I/O, no Ink, no `Date.now()` — the panel component renders
 * `QUICK_ACTIONS` itself (coloring the key) and this module's
 * `formatQuickActionLines` for the status text underneath.
 */

export type QuickActionKey = "c" | "s" | "S" | "r" | "h";

export interface QuickAction {
  key: QuickActionKey;
  label: string;
}

/** The four quick actions, in the order they are listed in the panel. */
export const QUICK_ACTIONS: ReadonlyArray<QuickAction> = [
  { key: "c", label: "refresh catalog" },
  { key: "s", label: "sync all projects" },
  { key: "S", label: "full sync all" },
  { key: "r", label: "reload" },
];

/** A fifth action, appended only when the hub is a local install — see {@link quickActionsFor}. */
export const LOCAL_HUB_ACTION: QuickAction = { key: "h", label: "start/stop local hub" };

/** `QUICK_ACTIONS`, plus {@link LOCAL_HUB_ACTION} when `showLocalHub` is true (only for a local hub install). */
export function quickActionsFor(showLocalHub: boolean): readonly QuickAction[] {
  return showLocalHub ? [...QUICK_ACTIONS, LOCAL_HUB_ACTION] : QUICK_ACTIONS;
}

/**
 * The quick actions panel's status: no action has run yet (`idle`), one is
 * currently running (`busy`, with `startedAt` — a clock reading — optional
 * since the panel does not need it to render), one just settled (`done`,
 * carrying its already-formatted result `message`), or the hub is not
 * configured at all (`unavailable`, with a display `reason` — in which
 * case every key is inert).
 */
export type QuickActionState =
  | { status: "idle" }
  | { status: "busy"; key: QuickActionKey; startedAt?: number }
  | { status: "done"; key: QuickActionKey; message: string }
  | { status: "unavailable"; reason: string };

/** `QUICK_ACTIONS`/`LOCAL_HUB_ACTION`'s label for `key` (every `QuickActionKey` is present, so this is never `undefined` in practice). */
function labelFor(key: QuickActionKey): string {
  return [...QUICK_ACTIONS, LOCAL_HUB_ACTION].find((action) => action.key === key)?.label ?? key;
}

/** The raw (unbounded) status text for `state`, or `""` when there is nothing to show yet (`idle`). */
function statusText(state: QuickActionState): string {
  switch (state.status) {
    case "idle":
      return "";
    case "busy":
      return `… ${labelFor(state.key)}`;
    case "done":
      return state.message;
    case "unavailable":
      return state.reason;
  }
}

/** `text` cut to at most `width` visible characters, trailing with `…` when something was cut off. `width` below 1 is treated as 1. */
function truncate(text: string, width: number): string {
  const safeWidth = Math.max(Math.floor(width), 1);
  if (text.length <= safeWidth) return text;
  return `${text.slice(0, Math.max(safeWidth - 1, 0))}…`;
}

/**
 * The quick actions panel's status line for `state`, truncated to `width`
 * (the panel's own inner content width) — always exactly one line, so the
 * panel's own fixed height never changes with the message length (see the
 * layout-stability rule other Dashboard panels follow). Empty for `idle`.
 */
export function formatQuickActionLines(width: number, state: QuickActionState): string[] {
  return [truncate(statusText(state), width)];
}
