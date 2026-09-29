/** Pure text for `kankaku --version`. No I/O: `adapters/package-versions.ts` reads the versions. */

export interface CarriedVersion {
  name: string;
  /** `undefined` when the package cannot be resolved or has no readable version. */
  version: string | undefined;
}

/** `kankaku <version>`, then one indented line per carried package: its version, or `not found`. */
export function formatVersionLines(ownVersion: string, carried: CarriedVersion[]): string[] {
  return [`kankaku ${ownVersion}`, ...carried.map(({ name, version }) => `  ${name} ${version ?? "not found"}`)];
}
