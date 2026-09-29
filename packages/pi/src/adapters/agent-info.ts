/**
 * Resolve `agent_version`/`plugin_version` for the hub's "Agent and
 * measurement quality" fields (`domain/hub-entry.ts`). Neither pi's
 * `ExtensionAPI` nor `ExtensionContext` exposes a version today (checked
 * against `@earendil-works/pi-coding-agent`'s type definitions), so pi's
 * own version is instead read from its installed package's `package.json`
 * — the same file Node's module resolution already points at. Both
 * resolvers run once, at extension load time (never a hot path), and
 * degrade to `undefined` on any failure: this is a best-effort label, and
 * a wrong guess is worse than an absent one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface AgentInfoDeps {
  /** Reads a file's contents as text. Defaults to `fs.readFileSync(path, "utf8")`. Injectable for tests. */
  readFile?: (path: string) => string;
  /** Resolves a bare module specifier to a `file://` URL, like `import.meta.resolve`. Injectable for tests. */
  resolveModule?: (specifier: string) => string;
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function readVersionField(path: string, readFile: (path: string) => string): string | undefined {
  try {
    const parsed = JSON.parse(readFile(path)) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** kankaku's own version, from the `package.json` at `packageRoot` (the directory containing `src/`). */
export function resolvePluginVersion(packageRoot: string, deps: AgentInfoDeps = {}): string | undefined {
  const readFile = deps.readFile ?? defaultReadFile;
  return readVersionField(join(packageRoot, "package.json"), readFile);
}

const MAX_UPWARD_HOPS = 6;

/**
 * pi's own version, resolved from the installed
 * `@earendil-works/pi-coding-agent` package: resolve its entry module, then
 * walk upward from that file looking for the nearest `package.json` whose
 * own `name` field actually matches the package (handling a nested
 * `dist/...` entry point), so a coincidental unrelated `package.json`
 * higher up a directory tree is never trusted.
 */
export function resolveAgentVersion(deps: AgentInfoDeps = {}): string | undefined {
  const readFile = deps.readFile ?? defaultReadFile;
  const resolveModule = deps.resolveModule ?? ((specifier: string) => import.meta.resolve(specifier));

  let entryUrl: string;
  try {
    entryUrl = resolveModule("@earendil-works/pi-coding-agent");
  } catch {
    return undefined;
  }

  let dir: string;
  try {
    dir = dirname(fileURLToPath(entryUrl));
  } catch {
    return undefined;
  }

  for (let hop = 0; hop < MAX_UPWARD_HOPS; hop++) {
    try {
      const parsed = JSON.parse(readFile(join(dir, "package.json"))) as { name?: unknown; version?: unknown };
      if (parsed.name === "@earendil-works/pi-coding-agent" && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Not here (or unreadable/malformed) — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return undefined;
}
