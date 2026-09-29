import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Reads the `version` field from `<root>/package.json`; `"0.0.0"` when it is missing. */
export function readAppVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/** This package's own version, read from its `package.json` next to `dist/adapters/app-info.js` (or `src/adapters/app-info.ts` under `tsx`) — used by the header bar's `>_ kankaku <version>` label. */
export function readOwnVersion(): string {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  return readAppVersion(root);
}
