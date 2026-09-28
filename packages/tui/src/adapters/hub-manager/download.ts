/**
 * Downloads a PocketBase release asset (from `HubManifest.pocketbase.assets`),
 * verifies its SHA256 against the manifest, and extracts the `pocketbase`
 * binary from the zip into `targetBinary`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extractSingleEntry } from "./zip.ts";

const BINARY_MODE = 0o755;

export interface DownloadAsset {
  url: string;
  sha256: string;
  file: string;
}

export interface DownloadPocketBaseDeps {
  /** Injectable for tests; the real caller passes the global `fetch`. */
  fetch: typeof fetch;
  /** Injectable for tests; defaults to `node:fs#mkdirSync` (recursive). */
  mkdir?: (dir: string) => void;
}

/**
 * Streams `asset.url` to a temp file next to `targetBinary`, verifies its
 * SHA256 against `asset.sha256`, extracts the single `pocketbase` entry
 * from the zip, and writes it to `targetBinary` (mode 0755) via temp file
 * + rename. Throws `checksum mismatch` and deletes the temp download when
 * the hash does not match; never leaves a partial or temp file behind on
 * any failure.
 */
export async function downloadPocketBase(asset: DownloadAsset, targetBinary: string, deps: DownloadPocketBaseDeps): Promise<void> {
  const mkdir = deps.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const targetDir = dirname(targetBinary);
  mkdir(targetDir);

  const response = await deps.fetch(asset.url);
  if (!response.ok) {
    throw new Error(`failed to download ${asset.url}: HTTP ${response.status}`);
  }
  const zipBytes = new Uint8Array(await response.arrayBuffer());

  const zipTmpPath = `${targetBinary}.${process.pid}.download.tmp`;
  writeFileSync(zipTmpPath, zipBytes);

  try {
    const hash = createHash("sha256").update(zipBytes).digest("hex");
    if (hash.toLowerCase() !== asset.sha256.toLowerCase()) {
      throw new Error(`checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${hash}`);
    }

    const binaryBytes = extractSingleEntry(zipBytes, "pocketbase");

    const binaryTmpPath = `${targetBinary}.${process.pid}.tmp`;
    try {
      writeFileSync(binaryTmpPath, binaryBytes, { mode: BINARY_MODE });
      renameSync(binaryTmpPath, targetBinary);
    } catch (error) {
      rmSync(binaryTmpPath, { force: true });
      throw error;
    }
  } finally {
    rmSync(zipTmpPath, { force: true });
  }
}
