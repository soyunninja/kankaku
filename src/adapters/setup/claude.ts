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
