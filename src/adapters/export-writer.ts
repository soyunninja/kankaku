import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveKankakuDir } from "./kankaku-dir.ts";

const EXPORT_SUBDIR = "export";

/**
 * Write `content` to `<dir>/export/<name>` (creating the `export`
 * subdirectory as needed, overwriting any existing file with the same
 * name) and return the absolute path it was written to.
 */
export function writeExport(dir: string, name: string, content: string): string {
  const exportDir = join(dir, EXPORT_SUBDIR);
  mkdirSync(exportDir, { recursive: true });
  const filePath = resolve(join(exportDir, name));
  writeFileSync(filePath, content);
  return filePath;
}

/** Writes exports under a kankaku dir resolved lazily against `fallbackCwd()` at call time. */
export class LazyExportWriter {
  private readonly dirOrRelative: string;
  private readonly fallbackCwd: () => string;

  constructor(dirOrRelative: string, fallbackCwd: () => string = () => process.cwd()) {
    this.dirOrRelative = dirOrRelative;
    this.fallbackCwd = fallbackCwd;
  }

  write(name: string, content: string): string {
    return writeExport(resolveKankakuDir(this.dirOrRelative, this.fallbackCwd()), name, content);
  }
}
