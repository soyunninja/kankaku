import { resolvePaths } from "./paths.ts";
import type { readState, PromptOpenState } from "./session-state.ts";
import type { writeCost } from "./cost-store.ts";

export interface StatuslineDeps {
  env: NodeJS.ProcessEnv;
  /** Epoch ms; used to stamp a written cost and to compute the open prompt's elapsed clock. */
  now: () => number;
  readState: typeof readState;
  writeCost: typeof writeCost;
}

/**
 * Renders the Claude Code statusline line. Never throws: any parsing or
 * I/O failure falls back to the bare `"kankaku"` string.
 *
 * Side effect: when `input.cost.total_cost_usd` is a finite number, writes
 * it (and the model id, when present) to `~/.kankaku/claude/cost/<session_id>.json`
 * via `deps.writeCost` — NEVER under the project (T7,
 * `odd/tasks/hook-tracking.md`: the statusline command is wired globally in
 * `~/.claude/settings.json`, so it runs in every session on the machine).
 * The project's own state file (`<KANKAKU_DIR>/claude/<session_id>.state.json`)
 * is only ever READ here, for the open-prompt clock, and is never created:
 * a missing state file renders as `idle` rather than creating anything.
 */
export function renderStatusline(input: unknown, deps: StatuslineDeps): string {
  try {
    if (!isPlainObject(input)) return "kankaku";

    const sessionId = readStringField(input.session_id);
    const workspace = isPlainObject(input.workspace) ? input.workspace : undefined;
    const cwd = readStringField(workspace?.current_dir) ?? readStringField(input.cwd);
    if (!sessionId || !cwd) return "kankaku";

    const cost = isPlainObject(input.cost) ? input.cost : undefined;
    const totalUsd = readFiniteNumberField(cost?.total_cost_usd);
    const model = isPlainObject(input.model) ? input.model : undefined;
    const modelId = readStringField(model?.id);

    if (totalUsd !== undefined) {
      deps.writeCost(deps.env, sessionId, {
        totalUsd,
        updatedAt: deps.now(),
        ...(modelId ? { model: modelId } : {}),
      });
    }

    const paths = resolvePaths({ env: deps.env, cwd, sessionId });
    const state = deps.readState(paths.stateFile);
    const clock = formatClock(state?.promptOpen ?? null, deps.now());

    return totalUsd !== undefined ? `kankaku ${clock} · $${totalUsd.toFixed(2)}` : `kankaku ${clock}`;
  } catch {
    return "kankaku";
  }
}

function formatClock(promptOpen: PromptOpenState | null, now: number): string {
  if (!promptOpen) return "idle";
  return formatElapsed(Math.max(0, now - promptOpen.startedAt));
}

/** `m:ss` under an hour, `h:mm:ss` from an hour onward. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  }
  return `${minutes}:${pad2(seconds)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readFiniteNumberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
