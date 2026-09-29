import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TuiConfig {
  roots: string[];
}

function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Read `<homeDir>/.kankaku/tui.json` (`{ "roots": [...] }`, `~` expanded
 * against `homeDir`). A missing or malformed file falls back to `cwd` as
 * the only root, so the app always has something to discover projects
 * under.
 */
export function readTuiConfig(homeDir: string, cwd: string): TuiConfig {
  const configPath = join(homeDir, ".kankaku", "tui.json");
  if (!existsSync(configPath)) {
    return { roots: [cwd] };
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !isStringArray((parsed as Record<string, unknown>)["roots"])) {
      return { roots: [cwd] };
    }
    const roots = (parsed as { roots: string[] }).roots.map((root) => expandHome(root, homeDir));
    return { roots };
  } catch {
    return { roots: [cwd] };
  }
}
