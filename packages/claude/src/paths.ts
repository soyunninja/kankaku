import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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

/**
 * Same rule as kankaku's `resolveKankakuDir` (kankaku/hub): an absolute
 * `KANKAKU_DIR` is used as-is, a relative one is joined against the session's
 * cwd. Inlined rather than imported so the light hooks (one per tool call)
 * never load the hub barrel for a two-line helper.
 */
export function resolveKankakuDir(dirOrRelative: string, cwd: string): string {
  return isAbsolute(dirOrRelative) ? dirOrRelative : join(cwd, dirOrRelative);
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
