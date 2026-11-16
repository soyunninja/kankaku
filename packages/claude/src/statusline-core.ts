import { resolvePaths } from "./paths.ts";
import type { readState, PromptOpenState } from "./session-state.ts";
import type { writeCost } from "./cost-store.ts";

export interface StatuslineDeps {
  env: NodeJS.ProcessEnv;
  /** Epoch ms; used to stamp a written cost and to compute the open prompt's elapsed clock. */
  now: () => number;
  readState: typeof readState;
  writeCost: typeof writeCost;
  /**
   * The session's work target as `<client> · <project> › <task>`, or
   * `undefined` when none resolves. Optional and read-only; a throw is
   * treated as "no label" so the clock and cost are still printed.
   */
  targetLabel?: (input: { env: NodeJS.ProcessEnv; cwd: string; sessionId: string }) => string | undefined;
  /** The git branch of `cwd`, or `undefined`. Optional; a throw is treated as "no branch". */
  gitBranch?: (cwd: string) => string | undefined;
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
 * After the clock and cost come, each after ` | ` and each left out when
 * unknown: the work target (`deps.targetLabel`), the git branch of the
 * working directory (`deps.gitBranch`) and `context_window.used_percentage`
 * as `ctx N%` (`kankaku 4m · $1.01 | Acme · Web › Fix login | ⎇ main | ctx 42%`).
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

    const contextWindow = isPlainObject(input.context_window) ? input.context_window : undefined;
    const contextUsed = readFiniteNumberField(contextWindow?.used_percentage);

    const sections = [totalUsd !== undefined ? `kankaku ${clock} · $${totalUsd.toFixed(2)}` : `kankaku ${clock}`];
    const label = readTargetLabel(deps, cwd, sessionId);
    if (label !== undefined) sections.push(label);
    const branch = readBranch(deps, cwd);
    if (branch !== undefined) sections.push(`⎇ ${branch}`);
    if (contextUsed !== undefined) sections.push(`ctx ${Math.round(contextUsed)}%`);
    return sections.join(" | ");
  } catch {
    return "kankaku";
  }
}

/** The target label on one line, or `undefined` when there is none or the lookup fails. */
function readTargetLabel(deps: StatuslineDeps, cwd: string, sessionId: string): string | undefined {
  try {
    const label = deps.targetLabel?.({ env: deps.env, cwd, sessionId })?.split(/\s+/).join(" ").trim();
    return label ? label : undefined;
  } catch {
    return undefined;
  }
}

/** The branch on one line, or `undefined` when there is none or the lookup fails. */
function readBranch(deps: StatuslineDeps, cwd: string): string | undefined {
  try {
    const branch = deps.gitBranch?.(cwd)?.split(/\s+/).join(" ").trim();
    return branch ? branch : undefined;
  } catch {
    return undefined;
  }
}

function formatClock(promptOpen: PromptOpenState | null, now: number): string {
  if (!promptOpen) return "idle";
  return formatElapsed(Math.max(0, now - promptOpen.startedAt));
}

/** Whole minutes: `4m` under an hour, `1h05m` from an hour onward. */
function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h${pad2(minutes)}m`;
  }
  return `${minutes}m`;
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
