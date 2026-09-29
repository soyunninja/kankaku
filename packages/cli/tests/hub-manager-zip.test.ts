import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { extractSingleEntry } from "../src/adapters/hub-manager/zip.ts";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

function writeUint32LE(buf: number[], value: number): void {
  buf.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function writeUint16LE(buf: number[], value: number): void {
  buf.push(value & 0xff, (value >>> 8) & 0xff);
}

/** Builds a minimal single-entry ZIP archive (no CRC verification, no extra fields) for a given compression method. */
function buildZip(entryName: string, content: Buffer, method: 0 | 8): Buffer {
  const nameBytes = Buffer.from(entryName, "utf8");
  const data = method === 8 ? deflateRawSync(content) : content;

  const localHeader: number[] = [];
  writeUint32LE(localHeader, LOCAL_FILE_HEADER_SIGNATURE);
  writeUint16LE(localHeader, 20); // version needed
  writeUint16LE(localHeader, 0); // flags
  writeUint16LE(localHeader, method); // compression method
  writeUint16LE(localHeader, 0); // mod time
  writeUint16LE(localHeader, 0); // mod date
  writeUint32LE(localHeader, 0); // crc32 (unused by the reader)
  writeUint32LE(localHeader, data.length); // compressed size
  writeUint32LE(localHeader, content.length); // uncompressed size
  writeUint16LE(localHeader, nameBytes.length); // file name length
  writeUint16LE(localHeader, 0); // extra field length

  const localHeaderOffset = 0;
  const localSection = Buffer.concat([Buffer.from(localHeader), nameBytes, data]);

  const centralHeader: number[] = [];
  writeUint32LE(centralHeader, CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16LE(centralHeader, 20); // version made by
  writeUint16LE(centralHeader, 20); // version needed
  writeUint16LE(centralHeader, 0); // flags
  writeUint16LE(centralHeader, method); // compression method
  writeUint16LE(centralHeader, 0); // mod time
  writeUint16LE(centralHeader, 0); // mod date
  writeUint32LE(centralHeader, 0); // crc32
  writeUint32LE(centralHeader, data.length); // compressed size
  writeUint32LE(centralHeader, content.length); // uncompressed size
  writeUint16LE(centralHeader, nameBytes.length); // file name length
  writeUint16LE(centralHeader, 0); // extra field length
  writeUint16LE(centralHeader, 0); // file comment length
  writeUint16LE(centralHeader, 0); // disk number start
  writeUint16LE(centralHeader, 0); // internal attrs
  writeUint32LE(centralHeader, 0); // external attrs
  writeUint32LE(centralHeader, localHeaderOffset); // relative offset of local header

  const centralSection = Buffer.concat([Buffer.from(centralHeader), nameBytes]);
  const centralDirectoryOffset = localSection.length;

  const eocd: number[] = [];
  writeUint32LE(eocd, EOCD_SIGNATURE);
  writeUint16LE(eocd, 0); // disk number
  writeUint16LE(eocd, 0); // disk with cd start
  writeUint16LE(eocd, 1); // entries on this disk
  writeUint16LE(eocd, 1); // total entries
  writeUint32LE(eocd, centralSection.length); // size of central directory
  writeUint32LE(eocd, centralDirectoryOffset); // offset of central directory
  writeUint16LE(eocd, 0); // comment length

  return Buffer.concat([localSection, centralSection, Buffer.from(eocd)]);
}

test("extractSingleEntry: reads a stored (method 0) entry", () => {
  const content = Buffer.from("stored content", "utf8");
  const zip = buildZip("pocketbase", content, 0);
  const extracted = extractSingleEntry(zip, "pocketbase");
  assert.deepEqual(Buffer.from(extracted), content);
});

test("extractSingleEntry: reads a deflated (method 8) entry", () => {
  const content = Buffer.from("x".repeat(500) + "some deflate-friendly content", "utf8");
  const zip = buildZip("pocketbase", content, 8);
  const extracted = extractSingleEntry(zip, "pocketbase");
  assert.deepEqual(Buffer.from(extracted), content);
});

test("extractSingleEntry: throws when the entry is not found", () => {
  const zip = buildZip("other-file", Buffer.from("data"), 0);
  assert.throws(() => extractSingleEntry(zip, "pocketbase"), /pocketbase/);
});

test("extractSingleEntry: throws for an unsupported compression method", () => {
  const zip = buildZip("pocketbase", Buffer.from("data"), 0);
  // Corrupt the compression method field in both the local header (offset 8
  // from its start, at absolute offset 8) and the central directory entry
  // (offset 10 from its start) to method 99 (unsupported), regardless of
  // which header the reader trusts for this field.
  zip[8] = 99;
  const centralIndex = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(centralIndex, -1);
  zip[centralIndex + 10] = 99;
  assert.throws(() => extractSingleEntry(zip, "pocketbase"), /unsupported compression method/);
});
