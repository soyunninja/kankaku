/**
 * Writer for Claude Code's `~/.claude/settings.json`: merges in kankaku's
 * `statusLine` and the bundled `kankaku-claude` plugin's own `hooks` (from
 * its `hooks/hooks.json`, read by `./claude-plugin.ts#readPluginHooks` and
 * resolved to `root` via `./claude-plugin.ts#locateClaudePlugin`), leaving
 * every other key, every foreign hook entry and every other event
 * untouched. Idempotent — a no-op when both already point at the given
 * root. Ours are identified by `../../domain/claude-integration.ts`'s
 * `ourHookCommandRoot`/`ourStatusLineCommandRoot`: a command matching
 * `node "<root>/dist/hook.js"`/`.../dist/statusline.js"` (or the legacy
 * `.../src/hook.ts"`/`.../src/statusline.ts"` checkout form) whose `<root>`
 * contains `kankaku-claude` or `packages/claude`.
 */
import { ourHookCommandRoot, ourStatusLineCommandRoot } from "../../domain/claude-integration.ts";
import { buildSettingsHooks } from "./claude-plugin.ts";
import type { HookEventEntry, PluginHooks } from "./claude-plugin.ts";
import { backupOnce, readJsonObjectOrEmpty, writeJsonAtomic } from "./json-writer.ts";

export interface PackagesWriteResult {
  changed: boolean;
}

/** The exact `statusLine.command` kankaku-tui writes for a given plugin root. */
export function statusLineCommand(root: string): string {
  return `node "${root}/dist/statusline.js"`;
}

function currentStatusLineCommand(existing: Record<string, unknown>): string | undefined {
  const statusLine = existing["statusLine"];
  if (!statusLine || typeof statusLine !== "object" || Array.isArray(statusLine)) return undefined;
  const command = (statusLine as Record<string, unknown>)["command"];
  return typeof command === "string" ? command : undefined;
}

function currentHooksObject(existing: Record<string, unknown>): Record<string, HookEventEntry[]> {
  const hooks = existing["hooks"];
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return {};
  const result: Record<string, HookEventEntry[]> = {};
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (Array.isArray(entries)) result[event] = entries as HookEventEntry[];
  }
  return result;
}

/** Never throws on a malformed entry (e.g. `null`, or missing/non-array `hooks`) — treated as foreign, never ours. */
function isOurHookEntry(entry: HookEventEntry): boolean {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((hook) => hook && typeof hook.command === "string" && ourHookCommandRoot(hook.command) !== undefined);
}

function sameEntries(a: HookEventEntry[], b: HookEventEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Write kankaku's statusLine and hooks (built from `pluginHooks` for
 * `root`) into `settingsPath`, merging with — never clobbering — every
 * other key, foreign hook entry and event already there. A no-op when the
 * statusLine and every plugin event's hooks already match `root` exactly;
 * a stale entry pointing at another root is replaced.
 */
export function writeClaudeIntegration(settingsPath: string, root: string, pluginHooks: PluginHooks): PackagesWriteResult {
  const existing = readJsonObjectOrEmpty(settingsPath);
  const desiredCommand = statusLineCommand(root);
  const statusLineChanged = currentStatusLineCommand(existing) !== desiredCommand;

  const currentHooks = currentHooksObject(existing);
  const desiredHooks = buildSettingsHooks(root, pluginHooks);
  const nextHooks: Record<string, HookEventEntry[]> = { ...currentHooks };
  let hooksChanged = false;

  for (const [event, desiredEntries] of Object.entries(desiredHooks)) {
    const currentEntries = currentHooks[event] ?? [];
    const foreignEntries = currentEntries.filter((entry) => !isOurHookEntry(entry));
    const merged = [...foreignEntries, ...desiredEntries];
    if (!sameEntries(currentEntries, merged)) hooksChanged = true;
    nextHooks[event] = merged;
  }

  if (!statusLineChanged && !hooksChanged) return { changed: false };

  backupOnce(settingsPath);
  writeJsonAtomic(settingsPath, { ...existing, statusLine: { type: "command", command: desiredCommand }, hooks: nextHooks });
  return { changed: true };
}

/**
 * Remove exactly kankaku's hooks and statusLine from `settingsPath`,
 * leaving every other key, every foreign hook entry and every other event
 * untouched. Drops an event's array once it is empty, and the `hooks` key
 * entirely once every event is empty. A no-op, with no backup and no
 * write, when neither is present.
 */
export function removeClaudeIntegration(settingsPath: string): PackagesWriteResult {
  const existing = readJsonObjectOrEmpty(settingsPath);
  const currentCommand = currentStatusLineCommand(existing);
  const hasOurStatusLine = currentCommand !== undefined && ourStatusLineCommandRoot(currentCommand) !== undefined;

  const currentHooks = currentHooksObject(existing);
  const nextHooks: Record<string, HookEventEntry[]> = {};
  let hooksChanged = false;
  for (const [event, entries] of Object.entries(currentHooks)) {
    const remaining = entries.filter((entry) => !isOurHookEntry(entry));
    if (remaining.length !== entries.length) hooksChanged = true;
    if (remaining.length > 0) nextHooks[event] = remaining;
  }

  if (!hasOurStatusLine && !hooksChanged) return { changed: false };

  backupOnce(settingsPath);
  const { statusLine: existingStatusLine, hooks: _hooks, ...rest } = existing;
  const result: Record<string, unknown> = { ...rest };
  if (!hasOurStatusLine && existingStatusLine !== undefined) result.statusLine = existingStatusLine;
  if (Object.keys(nextHooks).length > 0) result.hooks = nextHooks;
  writeJsonAtomic(settingsPath, result);
  return { changed: true };
}
