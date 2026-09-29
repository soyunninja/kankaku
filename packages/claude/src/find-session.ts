import { statSync } from "node:fs";
import { basename } from "node:path";
import { resolveClaudePid, type PsInfo } from "./claude-pid.ts";
import { readEventLog } from "./event-log.ts";
import { listStateFiles } from "./paths.ts";
import { readState } from "./session-state.ts";

export interface FindSessionInput {
  /** `<KANKAKU_DIR>/claude`. */
  claudeDir: string;
  env: NodeJS.ProcessEnv;
  /** The CLI's own pid; without it (and without the env override) nothing is found. */
  pid?: number;
  runPs?: (pid: number) => PsInfo | undefined;
  listStateFiles?: (claudeDir: string) => string[];
}

const SESSION_ID = /^[\w.-]+$/;

function activity(stateFile: string): number {
  let latest = 0;
  try { latest = statSync(stateFile).mtimeMs; } catch { /* unreadable: oldest */ }
  const events = readEventLog(stateFile.replace(/\.state\.json$/, ".events.jsonl"));
  const last = events[events.length - 1]?.ts;
  return typeof last === "number" && last > latest ? last : latest;
}

/**
 * The Claude Code session this CLI process runs under: `KANKAKU_CLAUDE_SESSION`
 * (a plain session id) wins; otherwise the CLI's pid is walked up to the
 * Claude process and matched against the project's session state files
 * (`pid`), most recent activity first. `undefined` when nothing matches.
 */
export function findSession(input: FindSessionInput): string | undefined {
  const override = input.env.KANKAKU_CLAUDE_SESSION?.trim();
  if (override && SESSION_ID.test(override)) return override;

  if (input.pid === undefined || input.runPs === undefined) return undefined;
  const claudePid = resolveClaudePid({ startPid: input.pid, runPs: input.runPs });
  if (!Number.isSafeInteger(claudePid) || claudePid <= 0) return undefined;

  const list = input.listStateFiles ?? listStateFiles;
  let best: { id: string; at: number } | undefined;
  for (const file of list(input.claudeDir)) {
    if (readState(file)?.pid !== claudePid) continue;
    const at = activity(file);
    if (!best || at > best.at) best = { id: basename(file).replace(/\.state\.json$/, ""), at };
  }
  return best?.id;
}
