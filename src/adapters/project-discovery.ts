import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import type { ProjectRef } from "../ports/project-source.ts";

/** How many directory levels below each root {@link discoverProjects} descends into by default. */
const DEFAULT_MAX_DEPTH = 5;

const SKIPPED_DIR_NAMES = new Set(["node_modules", ".git"]);

export interface DiscoverProjectsOptions {
  /** How many directory levels below each root to search. Defaults to {@link DEFAULT_MAX_DEPTH}. */
  maxDepth?: number;
}

function hasWorklog(dir: string): boolean {
  return existsSync(join(dir, ".kankaku", "worklog.jsonl"));
}

/** `node_modules`, `.git`, and any dot-prefixed (hidden) directory are never searched. */
function isSkipped(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIR_NAMES.has(name);
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => !isSkipped(name))
      .map((name) => join(dir, name))
      .filter((entry) => {
        try {
          return statSync(entry).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * The real (symlink-resolved) path, used only as the dedup key — the
 * `ProjectRef.dir` returned to callers always stays the path as
 * discovered. Falls back to `dir` itself when it cannot be resolved (e.g.
 * a permission error), so an unreadable directory never throws.
 */
function realDirPath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Walk `dir`, `depth` levels below its root: a directory with
 * `.kankaku/worklog.jsonl` is a project, and the walk still continues
 * below it — a pi session run once in a parent directory (`~/desarrollo`)
 * leaves a worklog there, and that stray file must never hide the real
 * projects beneath (`~/desarrollo/<client>/<project>`). Subdirectories
 * (skipping `node_modules`, `.git` and any hidden directory) are walked
 * one level deeper, up to `maxDepth`.
 */
function walk(dir: string, depth: number, maxDepth: number, found: Map<string, string>): void {
  if (hasWorklog(dir)) found.set(realDirPath(dir), dir);
  if (depth >= maxDepth) return;
  for (const child of childDirs(dir)) {
    walk(child, depth + 1, maxDepth, found);
  }
}

/** `basename(dir)`, or the last two path segments joined with `/` when that basename is ambiguous (shared by another discovered project). */
function projectName(dir: string, duplicateBasenames: Set<string>): string {
  const base = basename(dir);
  if (!duplicateBasenames.has(base)) return base;
  const segments = dir.split(sep).filter((segment) => segment.length > 0);
  return segments.slice(-2).join("/");
}

/**
 * Discover projects under `roots`, searching up to `options.maxDepth`
 * directory levels below each root (default {@link DEFAULT_MAX_DEPTH}): a
 * directory with `.kankaku/worklog.jsonl` is a project and is never
 * descended into (so a project nested inside another project is never
 * double-counted); otherwise its subdirectories are searched one level
 * deeper, skipping `node_modules`, `.git` and any hidden (dot-prefixed)
 * directory. Deduped by real (symlink-resolved) path; sorted by `name`,
 * which is the directory basename, or the last two path segments joined
 * with `/` when two discovered projects share a basename. Never throws on
 * an unreadable or missing root or subdirectory — those are silently
 * skipped.
 */
export function discoverProjects(roots: string[], options: DiscoverProjectsOptions = {}): ProjectRef[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const found = new Map<string, string>();

  for (const root of roots) {
    walk(root, 0, maxDepth, found);
  }

  const dirs = Array.from(found.values());
  const basenameCounts = new Map<string, number>();
  for (const dir of dirs) {
    const base = basename(dir);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }
  const duplicateBasenames = new Set(
    Array.from(basenameCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([base]) => base),
  );

  return dirs.map((dir) => ({ name: projectName(dir, duplicateBasenames), dir })).sort((a, b) => a.name.localeCompare(b.name));
}
