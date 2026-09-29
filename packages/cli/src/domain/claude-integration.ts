/**
 * Pure identification logic for kankaku-claude's own entries in Claude
 * Code's `~/.claude/settings.json`: a hook or statusLine command is ours
 * when it matches `node "<root>/dist/hook.js"` (or `.../dist/statusline.js"`
 * — the compiled form every install runs, since Node refuses to type-strip
 * a `.ts` file under `node_modules`) OR the legacy `.../src/hook.ts"` /
 * `.../src/statusline.ts"` checkout form a pre-dist `kankaku setup` wrote,
 * and `<root>` contains `kankaku-claude` or `packages/claude`. The legacy
 * form is still recognized — never as fully "configured" (see
 * `domain/setup-plan.ts#claudeCodeStatus`'s "outdated" detail) — so setup
 * replaces it with the dist form and uncheck still removes it. Reused by
 * `domain/setup-plan.ts` (configured/detail from plain facts),
 * `adapters/setup/agents.ts` (reading those facts from the real settings
 * file) and `adapters/setup/claude.ts` (merging/removing our own entries
 * on write). No I/O.
 */

export interface CommandMatch {
  root: string;
  /** True when the command uses the legacy `/src/*.ts` checkout form rather than the current `/dist/*.js` one. */
  legacy: boolean;
}

function matchSuffix(command: string, suffix: string): string | undefined {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^node "(.+)/${escaped}"$`).exec(command);
  if (!match) return undefined;
  const root = match[1]!;
  return root.includes("kankaku-claude") || root.includes("packages/claude") ? root : undefined;
}

function ourCommandMatch(command: string, currentSuffix: string, legacySuffix: string): CommandMatch | undefined {
  const currentRoot = matchSuffix(command, currentSuffix);
  if (currentRoot !== undefined) return { root: currentRoot, legacy: false };
  const legacyRoot = matchSuffix(command, legacySuffix);
  if (legacyRoot !== undefined) return { root: legacyRoot, legacy: true };
  return undefined;
}

/** Matches a hook command (`node "<root>/dist/hook.js"`, or the legacy `.../src/hook.ts"`), or `undefined` when `command` isn't one of ours. */
export function ourHookCommandMatch(command: string): CommandMatch | undefined {
  return ourCommandMatch(command, "dist/hook.js", "src/hook.ts");
}

/** Matches a statusLine command (`node "<root>/dist/statusline.js"`, or the legacy `.../src/statusline.ts"`), or `undefined` when `command` isn't one of ours. */
export function ourStatusLineCommandMatch(command: string): CommandMatch | undefined {
  return ourCommandMatch(command, "dist/statusline.js", "src/statusline.ts");
}

/** Extracts the plugin root from a hook command, current or legacy form, or `undefined` when `command` isn't one of ours. */
export function ourHookCommandRoot(command: string): string | undefined {
  return ourHookCommandMatch(command)?.root;
}

/** Extracts the plugin root from a statusLine command, current or legacy form, or `undefined` when `command` isn't one of ours. */
export function ourStatusLineCommandRoot(command: string): string | undefined {
  return ourStatusLineCommandMatch(command)?.root;
}

/**
 * Pure: the content of a generated user-level slash command — the plugin's
 * own `commands/<name>.md` verbatim, except that every
 * `${CLAUDE_PLUGIN_ROOT}` becomes the absolute plugin `root` (Claude Code
 * substitutes that variable only in plugin commands, never in user ones).
 */
export function buildCommandFileContent(root: string, source: string): string {
  return source.replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
}

/**
 * The plugin root a generated command file points at, or `undefined` when
 * the file is not one of ours. A file is ours when it contains a
 * `"<root>/dist/cli.js"` invocation whose `<root>` contains
 * `kankaku-claude` or `packages/claude`; the first such invocation wins.
 */
export function ourCommandFileRoot(content: string): string | undefined {
  for (const match of content.matchAll(/"([^"\n]+)\/dist\/cli\.js"/g)) {
    const root = match[1]!;
    if (root.includes("kankaku-claude") || root.includes("packages/claude")) return root;
  }
  return undefined;
}
