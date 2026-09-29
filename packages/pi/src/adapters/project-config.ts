import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkTargetCandidate } from "../domain/work-target.ts";
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

/**
 * Read `clientId`/`projectId` from `<dir>/config.json`, the lowest-precedence
 * source in `domain/work-target.ts#resolveWorkTarget`. Tolerates the same
 * failure modes as {@link readProjectClient}. `undefined` when `clientId`
 * is absent or not a string (a `projectId` without a `clientId` is not a
 * valid candidate); a non-string `projectId` is dropped, keeping `clientId`.
 */
export function readProjectTargetIds(dir: string): WorkTargetCandidate | undefined {
  const filePath = join(dir, CONFIG_FILE_NAME);
  if (!existsSync(filePath)) return undefined;

  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const clientId = record["clientId"];
    if (typeof clientId !== "string") return undefined;
    const projectId = record["projectId"];
    return typeof projectId === "string" ? { clientId, projectId } : { clientId };
  } catch {
    return undefined;
  }
}

/**
 * Merge `clientId`/`projectId` into `<dir>/config.json`, preserving every
 * other existing key (including the legacy `client` label). Writes
 * atomically (tmp + rename), mirroring `file-inflight-store.ts`. A missing
 * or malformed existing file is treated as `{}` rather than failing.
 */
export function writeProjectTargetIds(dir: string, ids: WorkTargetCandidate): void {
  const filePath = join(dir, CONFIG_FILE_NAME);
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }

  const merged = { ...existing, clientId: ids.clientId, ...(ids.projectId !== undefined ? { projectId: ids.projectId } : {}) };

  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, filePath);
}

/** Reads target ids from a kankaku dir resolved lazily against `fallbackCwd()` at call time. */
export class LazyProjectTargetSource {
  private readonly dirOrRelative: string;
  private readonly fallbackCwd: () => string;

  constructor(dirOrRelative: string, fallbackCwd: () => string = () => process.cwd()) {
    this.dirOrRelative = dirOrRelative;
    this.fallbackCwd = fallbackCwd;
  }

  read(): WorkTargetCandidate | undefined {
    return readProjectTargetIds(resolveKankakuDir(this.dirOrRelative, this.fallbackCwd()));
  }

  write(ids: WorkTargetCandidate): void {
    writeProjectTargetIds(resolveKankakuDir(this.dirOrRelative, this.fallbackCwd()), ids);
  }
}
