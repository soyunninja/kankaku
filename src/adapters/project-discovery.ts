import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectRef } from "../ports/project-source.ts";

function hasWorklog(dir: string): boolean {
  return existsSync(join(dir, ".kankaku", "worklog.jsonl"));
}

function childDirs(root: string): string[] {
  try {
    return readdirSync(root)
      .map((entry) => join(root, entry))
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
 * Discover projects under `roots`: a root that itself has
 * `.kankaku/worklog.jsonl` is a project; otherwise each direct child
 * directory with one is a project. Deduped by `dir`, sorted by `name`.
 * Never throws on an unreadable or missing root.
 */
export function discoverProjects(roots: string[]): ProjectRef[] {
  const byDir = new Map<string, ProjectRef>();

  for (const root of roots) {
    if (hasWorklog(root)) {
      byDir.set(root, { name: basename(root), dir: root });
      continue;
    }
    for (const child of childDirs(root)) {
      if (hasWorklog(child)) {
        byDir.set(child, { name: basename(child), dir: child });
      }
    }
  }

  return Array.from(byDir.values()).sort((a, b) => a.name.localeCompare(b.name));
}
