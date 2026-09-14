import { isAbsolute, join } from "node:path";

/**
 * Resolve the kankaku data directory: an absolute `dirOrRelative` is used
 * as-is, a relative one is joined against `cwd`. Shared by every lazy
 * adapter so the rule lives in exactly one place.
 */
export function resolveKankakuDir(dirOrRelative: string, cwd: string): string {
  return isAbsolute(dirOrRelative) ? dirOrRelative : join(cwd, dirOrRelative);
}
