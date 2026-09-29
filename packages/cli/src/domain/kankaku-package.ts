/**
 * Pure rules for recognising kankaku in a pi-family settings file
 * (`~/.pi/agent/settings.json`, `~/.gentle-shell/agent/settings.json`).
 *
 * pi lists packages as a bare source string or, to filter what a package
 * loads, as an object `{ "source": "<string>", "extensions": [...], ... }`.
 * kankaku's pi extension can be reached through several sources (the light
 * `kankaku-pi` package, the `kankaku` package that vendors it, the git
 * repository, a local checkout). Listing more than one of them loads the
 * extension more than once and doubles every measurement, so setup keeps
 * exactly one. No I/O.
 */

/** The source `kankaku setup` writes for a new install: the light, pi-only package. */
export const KANKAKU_PI_SPEC = "npm:kankaku-pi";

/** Listed in keep-precedence order: a developer's checkout wins, the `kankaku` package that vendors the extension loses. */
export type KankakuSourceKind = "local" | "npm-pi" | "git" | "npm";

const KEEP_PRECEDENCE: KankakuSourceKind[] = ["local", "npm-pi", "git", "npm"];

const GIT_SOURCE = /^(?:git:)?(?:(?:https?|ssh):\/\/(?:git@)?|git@)?github\.com[/:]soyunninja\/kankaku(?:\.git)?(?:[@#].*)?\/?$/i;

function isSchemeSource(source: string): boolean {
  return /^(?:npm|git):/.test(source) || /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || source.startsWith("git@");
}

/** Which kind of kankaku source `source` is, or `undefined` when it is not kankaku. */
export function classifyKankakuSource(source: string): KankakuSourceKind | undefined {
  if (source === "npm:kankaku-pi" || source.startsWith("npm:kankaku-pi@")) return "npm-pi";
  if (source === "npm:kankaku" || source.startsWith("npm:kankaku@")) return "npm";
  if (GIT_SOURCE.test(source)) return "git";
  if (isSchemeSource(source)) return undefined;
  const segments = source.split("/").filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  const parent = segments[segments.length - 2];
  if (last === "kankaku" || (last === "pi" && parent === "packages")) return "local";
  return undefined;
}

export function isKankakuPackage(source: string): boolean {
  return classifyKankakuSource(source) !== undefined;
}

/** pi deduplicates by package identity (npm name, git repository without ref, local path); two sources with the same identity are one load. */
function sourceIdentity(source: string, kind: KankakuSourceKind): string {
  if (kind === "npm-pi") return "npm:kankaku-pi";
  if (kind === "npm") return "npm:kankaku";
  if (kind === "git") return "git:github.com/soyunninja/kankaku";
  return `local:${source.replace(/\/+$/, "")}`;
}

/** The source string of a `packages` entry: the string itself, or the `source` of an object-form entry. */
export function entrySource(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const source = (entry as Record<string, unknown>)["source"];
    if (typeof source === "string") return source;
  }
  return undefined;
}

function recognisedKind(entry: unknown): KankakuSourceKind | undefined {
  const source = entrySource(entry);
  return source === undefined ? undefined : classifyKankakuSource(source);
}

/** One recognised source per distinct package identity, in the order first seen. */
export function loadedKankakuSources(sources: string[]): string[] {
  const seen = new Set<string>();
  const loaded: string[] = [];
  for (const source of sources) {
    const kind = classifyKankakuSource(source);
    if (kind === undefined) continue;
    const identity = sourceIdentity(source, kind);
    if (seen.has(identity)) continue;
    seen.add(identity);
    loaded.push(source);
  }
  return loaded;
}

/** The single source to keep among the recognised ones: local path > `npm:kankaku-pi` > git > `npm:kankaku`; the first listed wins a tie. `undefined` when none is recognised. */
export function pickKankakuSourceToKeep(sources: string[]): string | undefined {
  const loaded = loadedKankakuSources(sources);
  for (const kind of KEEP_PRECEDENCE) {
    const found = loaded.find((source) => classifyKankakuSource(source) === kind);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The `packages` list setup wants, or `undefined` when it is already right:
 * `npm:kankaku-pi` appended when no kankaku source is present; exactly one
 * source kept (see `pickKankakuSourceToKeep`) when several would load the
 * extension more than once; a single recognised source left as it is.
 * Every other entry, and the order, is untouched.
 */
export function reconcileKankakuEntries(entries: unknown[]): unknown[] | undefined {
  const sources = entries.map(entrySource).filter((source): source is string => source !== undefined);
  const loaded = loadedKankakuSources(sources);
  if (loaded.length === 0) return [...entries, KANKAKU_PI_SPEC];

  const recognisedCount = entries.filter((entry) => recognisedKind(entry) !== undefined).length;
  if (loaded.length === 1 && recognisedCount === 1) return undefined;

  const keep = pickKankakuSourceToKeep(sources)!;
  let kept = false;
  return entries.filter((entry) => {
    if (recognisedKind(entry) === undefined) return true;
    if (!kept && entrySource(entry) === keep) {
      kept = true;
      return true;
    }
    return false;
  });
}

/** `entries` without any recognised kankaku source, in either form. */
export function withoutKankakuEntries(entries: unknown[]): unknown[] {
  return entries.filter((entry) => recognisedKind(entry) === undefined);
}
