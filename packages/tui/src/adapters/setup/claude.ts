/**
 * Writer for Claude Code's `~/.claude/settings.json`: sets `statusLine` to
 * run kankaku's `src/statusline.ts` from the given `kankaku-claude`
 * checkout, leaving every other key untouched. A no-op when the
 * `statusLine.command` already runs that exact statusline.ts for this
 * checkout.
 */
import { backupOnce, readJsonObjectOrEmpty, writeJsonAtomic } from "./json-writer.ts";

export interface PackagesWriteResult {
  changed: boolean;
}

/** The exact `statusLine.command` kankaku-tui writes for a given `kankaku-claude` checkout path. */
export function statusLineCommand(checkoutPath: string): string {
  return `node "${checkoutPath}/src/statusline.ts"`;
}

export function writeStatusLine(settingsPath: string, checkoutPath: string): PackagesWriteResult {
  const existing = readJsonObjectOrEmpty(settingsPath);
  const command = statusLineCommand(checkoutPath);

  const currentStatusLine = existing["statusLine"];
  const currentCommand =
    currentStatusLine && typeof currentStatusLine === "object" && !Array.isArray(currentStatusLine)
      ? (currentStatusLine as Record<string, unknown>)["command"]
      : undefined;

  if (currentCommand === command) return { changed: false };

  backupOnce(settingsPath);
  writeJsonAtomic(settingsPath, { ...existing, statusLine: { type: "command", command } });
  return { changed: true };
}

/**
 * Removes `statusLine` only when its `command` contains `"kankaku"` (i.e.
 * it looks like kankaku's own statusline, not some other tool's), leaving
 * every other key untouched. A no-op, with no backup and no write, when
 * there is no `statusLine` or it belongs to something else.
 */
export function removeStatusLine(settingsPath: string): PackagesWriteResult {
  const existing = readJsonObjectOrEmpty(settingsPath);
  const currentStatusLine = existing["statusLine"];
  const currentCommand =
    currentStatusLine && typeof currentStatusLine === "object" && !Array.isArray(currentStatusLine)
      ? (currentStatusLine as Record<string, unknown>)["command"]
      : undefined;

  if (typeof currentCommand !== "string" || !currentCommand.includes("kankaku")) return { changed: false };

  backupOnce(settingsPath);
  const { statusLine: _statusLine, ...rest } = existing;
  writeJsonAtomic(settingsPath, rest);
  return { changed: true };
}
