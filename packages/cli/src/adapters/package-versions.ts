/**
 * The versions of the packages `kankaku` carries (`kankaku-pi`,
 * `kankaku-claude`, `kankaku-hub`), resolved the same way the rest of the
 * code finds them (`require.resolve("<name>/package.json")`, see
 * `hub-manager/package.ts` and `setup/claude-plugin.ts`). Never throws: a
 * package that cannot be resolved or read has an `undefined` version.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { CarriedVersion } from "../domain/version-info.ts";

const defaultRequire = createRequire(import.meta.url);

export const CARRIED_PACKAGES = ["kankaku-pi", "kankaku-claude", "kankaku-hub"] as const;

function versionOf(name: string, resolve: (specifier: string) => string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(resolve(`${name}/package.json`), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Each carried package's version, in {@link CARRIED_PACKAGES} order. `resolve` defaults to `require.resolve`; tests inject one. */
export function readCarriedVersions(resolve: (specifier: string) => string = (specifier) => defaultRequire.resolve(specifier)): CarriedVersion[] {
  return CARRIED_PACKAGES.map((name) => ({ name, version: versionOf(name, resolve) }));
}
