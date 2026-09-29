/**
 * Locates the installed `kankaku-hub` npm package (a real registry
 * dependency) and reads/validates its `hub-manifest.json`.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseHubManifest } from "../../domain/local-hub-model.ts";
import type { HubManifest } from "../../domain/local-hub-model.ts";

const defaultRequire = createRequire(import.meta.url);

export interface LocateHubPackageResult {
  dir: string;
  manifest: HubManifest;
}

/**
 * Resolves `kankaku-hub/package.json` through `resolve` (defaulting to
 * `require.resolve`), then reads and validates the `hub-manifest.json`
 * next to it. Throws a clear error when the package cannot be resolved,
 * its manifest file is missing, or the manifest fails validation.
 */
export function locateHubPackage(resolve: (specifier: string) => string = (specifier) => defaultRequire.resolve(specifier)): LocateHubPackageResult {
  let packageJsonPath: string;
  try {
    packageJsonPath = resolve("kankaku-hub/package.json");
  } catch (error) {
    throw new Error(`kankaku-hub package is not installed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const dir = dirname(packageJsonPath);
  const manifestPath = join(dir, "hub-manifest.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const manifest = parseHubManifest(JSON.parse(raw) as unknown);
  return { dir, manifest };
}
