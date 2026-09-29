/**
 * A minimal ZIP reader: just enough to find and extract one entry from a
 * PocketBase release archive. Parses the end-of-central-directory record,
 * walks the central directory to find the named entry, then reads its
 * local file header to locate the entry's data. Supports compression
 * method 0 (stored) and 8 (deflate, via `node:zlib#inflateRawSync`);
 * anything else (the central directory's extra fields, comments, other
 * entries, other compression methods) is ignored or rejected. No external
 * dependency, and no CRC verification — the caller (`download.ts`)
 * verifies the whole archive's SHA256 before extraction.
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

const EOCD_MIN_SIZE = 22;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;
const MAX_COMMENT_LENGTH = 65535;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

interface CentralDirectoryEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/** Scans backward from the end of `zip` for the end-of-central-directory signature, returning its offset. */
function findEndOfCentralDirectoryOffset(zip: Uint8Array): number {
  const earliestOffset = Math.max(0, zip.length - EOCD_MIN_SIZE - MAX_COMMENT_LENGTH);
  for (let offset = zip.length - EOCD_MIN_SIZE; offset >= earliestOffset; offset--) {
    if (readUint32LE(zip, offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("not a valid zip archive: end-of-central-directory record not found");
}

function readCentralDirectoryEntries(zip: Uint8Array): CentralDirectoryEntry[] {
  const eocdOffset = findEndOfCentralDirectoryOffset(zip);
  const totalEntries = readUint16LE(zip, eocdOffset + 10);
  let offset = readUint32LE(zip, eocdOffset + 16);

  const entries: CentralDirectoryEntry[] = [];
  for (let i = 0; i < totalEntries; i++) {
    if (readUint32LE(zip, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("not a valid zip archive: central directory entry signature mismatch");
    }
    const compressionMethod = readUint16LE(zip, offset + 10);
    const compressedSize = readUint32LE(zip, offset + 20);
    const fileNameLength = readUint16LE(zip, offset + 28);
    const extraFieldLength = readUint16LE(zip, offset + 30);
    const fileCommentLength = readUint16LE(zip, offset + 32);
    const localHeaderOffset = readUint32LE(zip, offset + 42);
    const nameBytes = zip.slice(offset + CENTRAL_DIRECTORY_HEADER_SIZE, offset + CENTRAL_DIRECTORY_HEADER_SIZE + fileNameLength);
    const name = Buffer.from(nameBytes).toString("utf8");

    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    offset += CENTRAL_DIRECTORY_HEADER_SIZE + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return entries;
}

/**
 * Extracts `entryName` (exact match against the central directory's file
 * name) from `zip`, decompressing it if needed. Throws when the entry is
 * missing or uses a compression method other than stored (0) or deflate
 * (8).
 */
export function extractSingleEntry(zip: Uint8Array, entryName: string): Uint8Array {
  const entries = readCentralDirectoryEntries(zip);
  const entry = entries.find((candidate) => candidate.name === entryName);
  if (!entry) {
    throw new Error(`entry "${entryName}" not found in zip (found: ${entries.map((e) => e.name).join(", ") || "none"})`);
  }

  if (readUint32LE(zip, entry.localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error("not a valid zip archive: local file header signature mismatch");
  }
  const localFileNameLength = readUint16LE(zip, entry.localHeaderOffset + 26);
  const localExtraFieldLength = readUint16LE(zip, entry.localHeaderOffset + 28);
  const dataOffset = entry.localHeaderOffset + LOCAL_FILE_HEADER_SIZE + localFileNameLength + localExtraFieldLength;
  const compressedData = zip.slice(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === METHOD_STORED) return compressedData;
  if (entry.compressionMethod === METHOD_DEFLATE) return new Uint8Array(inflateRawSync(compressedData));
  throw new Error(`entry "${entryName}" uses unsupported compression method ${entry.compressionMethod}`);
}
