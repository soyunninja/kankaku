/**
 * Locates the bundled `kankaku-claude` npm package (a real dependency of
 * this package, resolved the same way `hub-manager/package.ts#locateHubPackage`
 * resolves `kankaku-hub`) and reads its own `hooks/hooks.json` — the single
 * source of truth for which Claude Code events kankaku-claude hooks into.
 * `buildSettingsHooks` is the pure transform from that file's shape into
 * `~/.claude/settings.json`'s own `hooks` object for a resolved root.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const defaultRequire = createRequire(import.meta.url);

export interface LocateClaudePluginResult {
  root: string;
}

export interface HookDefinition {
  type: string;
  command: string;
  timeout?: number;
}

export interface HookEventEntry {
  matcher?: string;
  hooks: HookDefinition[];
}

/** `hooks/hooks.json`'s own `hooks` object: one array of entries per Claude Code event. */
export type PluginHooks = Record<string, HookEventEntry[]>;

/**
 * Resolves the kankaku-claude plugin's root directory: `override` when
 * given (validated to contain `hooks/hooks.json` and a built `dist/hook.js`
 * — the compiled form every hook/statusLine command runs, since Node
 * refuses to type-strip a `.ts` file under `node_modules` — a clear error
 * otherwise), else the bundled package via
 * `require.resolve("kankaku-claude/package.json")`.
 */
export function locateClaudePlugin(override?: string): LocateClaudePluginResult {
  if (override !== undefined) {
    const hooksPath = join(override, "hooks", "hooks.json");
    if (!existsSync(hooksPath)) {
      throw new Error(`${override} does not look like a kankaku-claude plugin root (expected hooks/hooks.json and dist/hook.js)`);
    }
    const hookScriptPath = join(override, "dist", "hook.js");
    if (!existsSync(hookScriptPath)) {
      throw new Error(`${override} has hooks/hooks.json but no dist/hook.js — run npm run build in ${override} first`);
    }
    return { root: override };
  }

  let packageJsonPath: string;
  try {
    packageJsonPath = defaultRequire.resolve("kankaku-claude/package.json");
  } catch (error) {
    throw new Error(`kankaku-claude package is not installed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { root: dirname(packageJsonPath) };
}

/** Parses `<root>/hooks/hooks.json` and returns its own `hooks` object, exactly as written there (still carrying `${CLAUDE_PLUGIN_ROOT}`). */
export function readPluginHooks(root: string): PluginHooks {
  const hooksPath = join(root, "hooks", "hooks.json");
  const raw = JSON.parse(readFileSync(hooksPath, "utf8")) as { hooks?: PluginHooks };
  return raw.hooks ?? {};
}

/**
 * Pure: turns the plugin's own `hooks/hooks.json` shape into the exact
 * `hooks` object `~/.claude/settings.json` expects for `root` — every
 * `${CLAUDE_PLUGIN_ROOT}` in a command replaced with the absolute `root`,
 * keeping event order, matchers and timeouts unchanged.
 */
export function buildSettingsHooks(root: string, pluginHooks: PluginHooks): PluginHooks {
  const result: PluginHooks = {};
  for (const [event, entries] of Object.entries(pluginHooks)) {
    result[event] = entries.map((entry) => ({
      ...entry,
      hooks: entry.hooks.map((hook) => ({ ...hook, command: hook.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", root) })),
    }));
  }
  return result;
}
