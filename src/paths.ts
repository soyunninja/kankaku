import { readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveKankakuDir } from "kankaku/hub";

export interface ResolvePathsInput {
  env: NodeJS.ProcessEnv;
  cwd: string;
  sessionId: string;
}

export interface ResolvedPaths {
  kankakuDir: string;
  claudeDir: string;
  eventsFile: string;
  stateFile: string;
}

/** `<KANKAKU_DIR or .kankaku>/claude/<sessionId>.{events.jsonl,state.json}`. */
export function resolvePaths(input: ResolvePathsInput): ResolvedPaths {
  const kankakuDir = resolveKankakuDir(input.env.KANKAKU_DIR ?? ".kankaku", input.cwd);
  const claudeDir = join(kankakuDir, "claude");
  return {
    kankakuDir,
    claudeDir,
    eventsFile: join(claudeDir, `${input.sessionId}.events.jsonl`),
    stateFile: join(claudeDir, `${input.sessionId}.state.json`),
  };
}

/** Every `*.state.json` path in `claudeDir`, absolute. Empty array when the directory does not exist. */
export function listStateFiles(claudeDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(claudeDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".state.json"))
    .map((name) => join(claudeDir, name));
}
