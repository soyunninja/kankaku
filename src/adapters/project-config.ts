import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveKankakuDir } from "./kankaku-dir.ts";

const CONFIG_FILE_NAME = "config.json";

/**
 * Read the project's default billing client from `<dir>/config.json`
 * (`{ "client": "acme" }`), the lowest-precedence source in
 * `domain/client-label.ts#resolveClient`. `dir` is the kankaku dir (same
 * directory as the work log).
 *
 * Tolerates a missing file, malformed JSON, a non-object document, or a
 * `client` field that is not a string — all return `undefined` rather than
 * throwing, since this file is optional and hand-edited.
 */
export function readProjectClient(dir: string): string | undefined {
  const filePath = join(dir, CONFIG_FILE_NAME);
  if (!existsSync(filePath)) return undefined;

  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const client = (parsed as Record<string, unknown>)["client"];
    return typeof client === "string" ? client : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the project client from a kankaku dir resolved lazily against `fallbackCwd()` at call time. */
export class LazyProjectClientSource {
  private readonly dirOrRelative: string;
  private readonly fallbackCwd: () => string;

  constructor(dirOrRelative: string, fallbackCwd: () => string = () => process.cwd()) {
    this.dirOrRelative = dirOrRelative;
    this.fallbackCwd = fallbackCwd;
  }

  read(): string | undefined {
    return readProjectClient(resolveKankakuDir(this.dirOrRelative, this.fallbackCwd()));
  }
}
