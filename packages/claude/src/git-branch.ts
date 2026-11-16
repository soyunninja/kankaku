import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The checked-out git branch of `cwd`, read straight from `HEAD` (no `git`
 * process: the statusline renders often). Walks up from `cwd` to the first
 * `.git`: a directory, or a linked worktree's `gitdir: <path>` file. A
 * detached HEAD is shown as its 7-character commit. `undefined` outside a
 * repository or on anything unreadable. Node builtins only; never throws.
 */
export function readGitBranch(cwd: string): string | undefined {
  try {
    const gitDir = findGitDir(resolve(cwd));
    if (gitDir === undefined) return undefined;
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    if (/^[0-9a-f]{40,64}$/.test(head)) return head.slice(0, 7);
    return undefined;
  } catch {
    return undefined;
  }
}

function findGitDir(start: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = join(dir, ".git");
    try {
      const stats = statSync(candidate);
      if (stats.isDirectory()) return candidate;
      if (stats.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, "utf8"));
        if (!pointer) return undefined;
        const target = pointer[1]!.trim();
        return isAbsolute(target) ? target : resolve(dir, target);
      }
    } catch {
      // no .git here: keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
