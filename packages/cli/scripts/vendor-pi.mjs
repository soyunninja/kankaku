// Vendors the pi extension into this package so it ships inside the
// `kankaku` tarball at a fixed path (`vendor/kankaku-pi/`), which is where
// the `pi` manifest in package.json points. Run by `prepack`.
//
// Copies `../pi/{src/,package.json,LICENSE}` into the output directory
// (default `<this package>/vendor/kankaku-pi`; override with `--out <dir>`
// or KANKAKU_VENDOR_OUT). Messages go to stderr so `npm pack --json` stays
// parseable. The output is removed and recreated, so the
// result is deterministic. No network.
//
// Outside the monorepo (no sibling `../pi`) it does nothing and exits 0, so
// `npm pack` of an already-vendored tree still works.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piDir = resolve(cliDir, "..", "pi");

function outputDir() {
  const flag = process.argv.indexOf("--out");
  if (flag !== -1) {
    const value = process.argv[flag + 1];
    if (!value) throw new Error("vendor-pi: --out needs a directory");
    return resolve(value);
  }
  if (process.env.KANKAKU_VENDOR_OUT) return resolve(process.env.KANKAKU_VENDOR_OUT);
  return join(cliDir, "vendor", "kankaku-pi");
}

function main() {
  if (!existsSync(piDir)) {
    console.error("vendor-pi: no sibling ../pi package (not in the monorepo); leaving vendor/ as it is");
    return;
  }
  const extension = join(piDir, "src", "extension.ts");
  if (!existsSync(extension)) throw new Error(`vendor-pi: ${extension} is missing; cannot vendor the pi extension`);

  const out = outputDir();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(piDir, "src"), join(out, "src"), { recursive: true });
  for (const file of ["package.json", "LICENSE"]) {
    const from = join(piDir, file);
    if (!existsSync(from)) throw new Error(`vendor-pi: ${from} is missing`);
    cpSync(from, join(out, file));
  }
  console.error(`vendor-pi: vendored ${piDir} into ${out}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
