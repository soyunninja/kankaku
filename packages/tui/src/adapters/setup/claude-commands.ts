/**
 * Generates the `/kankaku:*` slash commands as user-level commands. Claude
 * Code only offers the plugin's own `commands/*.md` when it loads kankaku
 * AS a plugin, but `kankaku setup` wires hooks and statusLine through
 * `~/.claude/settings.json` instead, so the commands are written to
 * `~/.claude/commands/kankaku/<name>.md` (the `kankaku/` sub-directory
 * makes each one `/kankaku:<name>`). Each file is the plugin's command
 * verbatim except that `${CLAUDE_PLUGIN_ROOT}` — substituted only in plugin
 * commands — becomes the absolute plugin root (see
 * `../../domain/claude-integration.ts#buildCommandFileContent`).
 *
 * Only files recognised as ours (`ourCommandFileRoot`) are ever replaced or
 * removed; anything else in that directory is reported and left alone.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCommandFileContent, ourCommandFileRoot } from "../../domain/claude-integration.ts";

export interface PluginCommand {
  /** File name without `.md`. */
  name: string;
  /** The plugin's own command file, still carrying `${CLAUDE_PLUGIN_ROOT}`. */
  source: string;
}

/** What one write/remove pass did, as absolute file paths (each list sorted). */
export interface CommandsWriteResult {
  wrote: string[];
  unchanged: string[];
  removed: string[];
  /** Entries in the directory that are not kankaku's own; never touched. */
  foreign: string[];
}

/** `<home>/.claude/commands/kankaku`. */
export function commandsDirectory(homeDir: string): string {
  return join(homeDir, ".claude", "commands", "kankaku");
}

/** Reads `<root>/commands/*.md`, sorted by name; a missing directory reads as none. */
export function readPluginCommands(root: string): PluginCommand[] {
  const dir = join(root, "commands");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => ({ name: file.slice(0, -".md".length), source: readFileSync(join(dir, file), "utf8") }));
}

function emptyResult(): CommandsWriteResult {
  return { wrote: [], unchanged: [], removed: [], foreign: [] };
}

function readOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function isOurs(file: string): boolean {
  const content = readOrUndefined(file);
  return content !== undefined && ourCommandFileRoot(content) !== undefined;
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/**
 * Makes `<home>/.claude/commands/kankaku/` hold exactly one generated file
 * per plugin command: written when new or different, `unchanged` when
 * byte-identical, and generated files no longer shipped by the plugin are
 * removed. A file at a target path that is not ours (and not already
 * identical) is never overwritten.
 */
export function writeClaudeCommands(homeDir: string, root: string, commands: PluginCommand[]): CommandsWriteResult {
  const dir = commandsDirectory(homeDir);
  const result = emptyResult();
  mkdirSync(dir, { recursive: true });

  const wanted = new Set<string>();
  for (const command of commands) {
    const file = join(dir, `${command.name}.md`);
    wanted.add(`${command.name}.md`);
    const content = buildCommandFileContent(root, command.source);
    const existing = readOrUndefined(file);
    if (existing === content) result.unchanged.push(file);
    else if (existing !== undefined && ourCommandFileRoot(existing) === undefined) result.foreign.push(file);
    else {
      writeAtomic(file, content);
      result.wrote.push(file);
    }
  }

  for (const entry of readdirSync(dir).sort()) {
    if (wanted.has(entry)) continue;
    const file = join(dir, entry);
    if (entry.endsWith(".md") && isOurs(file)) {
      rmSync(file);
      result.removed.push(file);
    } else {
      result.foreign.push(file);
    }
  }

  result.foreign.sort();
  return result;
}

/**
 * Removes every generated command file and the `kankaku/` directory when it
 * ends up empty. Foreign entries stay (and are reported); nothing outside
 * `commands/kankaku/` is ever touched.
 */
export function removeClaudeCommands(homeDir: string): CommandsWriteResult {
  const dir = commandsDirectory(homeDir);
  const result = emptyResult();
  if (!existsSync(dir)) return result;

  for (const entry of readdirSync(dir).sort()) {
    const file = join(dir, entry);
    if (entry.endsWith(".md") && isOurs(file)) {
      rmSync(file);
      result.removed.push(file);
    } else {
      result.foreign.push(file);
    }
  }

  if (result.foreign.length === 0) rmdirSync(dir);
  return result;
}
