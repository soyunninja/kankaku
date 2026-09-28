/**
 * Client (billing target) label resolution: pure, no I/O.
 *
 * A client name identifies who a piece of work is billed to. It can come
 * from three sources, in decreasing precedence: the pi session (set with
 * `/kankaku client <name>`), the `KANKAKU_CLIENT` environment variable, or
 * the project's `.kankaku/config.json`.
 */

/** Safe client name: letters, digits, `.`, `_`, `-`, 1-64 chars. */
const CLIENT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Property names that behave specially on a plain object; never usable as a client name. */
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export interface ClientSources {
  /** Set for the current pi session via `/kankaku client <name>`. Highest precedence. */
  session?: string;
  /** From the `KANKAKU_CLIENT` environment variable. */
  env?: string;
  /** From the project's `.kankaku/config.json`. Lowest precedence. */
  project?: string;
}

export type ClientSourceName = "session" | "env" | "project";

/** `true` when `value` is a non-empty, safe client name. */
export function isValidClient(value: string): boolean {
  return CLIENT_PATTERN.test(value) && !RESERVED_NAMES.has(value);
}

/** Trim and validate a candidate client name; `undefined` when absent or invalid. */
function normalize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return isValidClient(trimmed) ? trimmed : undefined;
}

/**
 * Resolve the effective client name from `session`, `env` and `project`
 * sources, in that precedence order. Each candidate is trimmed; an empty
 * string or a value that does not match the safe client-name pattern is
 * treated as absent and resolution falls through to the next source.
 */
export function resolveClient(sources: ClientSources): string | undefined {
  return normalize(sources.session) ?? normalize(sources.env) ?? normalize(sources.project);
}

/** Which source produced {@link resolveClient}'s result, or `undefined` when none applies. */
export function resolveClientSource(sources: ClientSources): ClientSourceName | undefined {
  if (normalize(sources.session) !== undefined) return "session";
  if (normalize(sources.env) !== undefined) return "env";
  if (normalize(sources.project) !== undefined) return "project";
  return undefined;
}
