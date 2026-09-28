/**
 * Pure identification logic for kankaku-claude's own entries in Claude
 * Code's `~/.claude/settings.json`: a hook or statusLine command is ours
 * when it matches `node "<root>/src/hook.ts"` (or `.../src/statusline.ts"`)
 * and `<root>` contains `kankaku-claude` or `packages/claude`. Reused by
 * `domain/setup-plan.ts` (configured/detail from plain facts),
 * `adapters/setup/agents.ts` (reading those facts from the real settings
 * file) and `adapters/setup/claude.ts` (merging/removing our own entries
 * on write). No I/O.
 */

function ourCommandRoot(command: string, scriptSuffix: string): string | undefined {
  const escaped = scriptSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^node "(.+)/${escaped}"$`).exec(command);
  if (!match) return undefined;
  const root = match[1]!;
  return root.includes("kankaku-claude") || root.includes("packages/claude") ? root : undefined;
}

/** Extracts the plugin root from a hook command (`node "<root>/src/hook.ts"`), or `undefined` when `command` isn't one of ours. */
export function ourHookCommandRoot(command: string): string | undefined {
  return ourCommandRoot(command, "src/hook.ts");
}

/** Extracts the plugin root from a statusLine command (`node "<root>/src/statusline.ts"`), or `undefined` when `command` isn't one of ours. */
export function ourStatusLineCommandRoot(command: string): string | undefined {
  return ourCommandRoot(command, "src/statusline.ts");
}
