import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadPocketBase } from "../src/adapters/hub-manager/download.ts";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

function writeUint32LE(buf: number[], value: number): void {
  buf.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function writeUint16LE(buf: number[], value: number): void {
  buf.push(value & 0xff, (value >>> 8) & 0xff);
}

function buildZip(entryName: string, content: Buffer, method: 0 | 8): Buffer {
  const nameBytes = Buffer.from(entryName, "utf8");
  const data = method === 8 ? deflateRawSync(content) : content;

  const localHeader: number[] = [];
  writeUint32LE(localHeader, LOCAL_FILE_HEADER_SIGNATURE);
  writeUint16LE(localHeader, 20);
  writeUint16LE(localHeader, 0);
  writeUint16LE(localHeader, method);
  writeUint16LE(localHeader, 0);
  writeUint16LE(localHeader, 0);
  writeUint32LE(localHeader, 0);
  writeUint32LE(localHeader, data.length);
  writeUint32LE(localHeader, content.length);
  writeUint16LE(localHeader, nameBytes.length);
  writeUint16LE(localHeader, 0);

  const localSection = Buffer.concat([Buffer.from(localHeader), nameBytes, data]);

  const centralHeader: number[] = [];
  writeUint32LE(centralHeader, CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16LE(centralHeader, 20);
  writeUint16LE(centralHeader, 20);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, method);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint32LE(centralHeader, 0);
  writeUint32LE(centralHeader, data.length);
  writeUint32LE(centralHeader, content.length);
  writeUint16LE(centralHeader, nameBytes.length);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint16LE(centralHeader, 0);
  writeUint32LE(centralHeader, 0);
  writeUint32LE(centralHeader, 0);

  const centralSection = Buffer.concat([Buffer.from(centralHeader), nameBytes]);
  const centralDirectoryOffset = localSection.length;

  const eocd: number[] = [];
  writeUint32LE(eocd, EOCD_SIGNATURE);
  writeUint16LE(eocd, 0);
  writeUint16LE(eocd, 0);
  writeUint16LE(eocd, 1);
  writeUint16LE(eocd, 1);
  writeUint32LE(eocd, centralSection.length);
  writeUint32LE(eocd, centralDirectoryOffset);
  writeUint16LE(eocd, 0);

  return Buffer.concat([localSection, centralSection, Buffer.from(eocd)]);
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-download-"));
}

function fetchReturning(zip: Buffer, status = 200): typeof fetch {
  return (async () => new Response(new Uint8Array(zip), { status })) as typeof fetch;
}

test("downloadPocketBase: verifies checksum, extracts the binary and writes it with mode 0755", async () => {
  const content = Buffer.from("#!/bin/sh\necho pocketbase\n", "utf8");
  const zip = buildZip("pocketbase", content, 0);
  const sha256 = createHash("sha256").update(zip).digest("hex");

  const dir = makeDir();
  try {
    const targetBinary = join(dir, "bin", "pocketbase");
    await downloadPocketBase({ url: "https://example.test/pb.zip", sha256, file: "pb.zip" }, targetBinary, { fetch: fetchReturning(zip) });

    assert.equal(existsSync(targetBinary), true);
    assert.deepEqual(readFileSync(targetBinary), content);
    const mode = statSync(targetBinary).mode & 0o777;
    assert.equal(mode, 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadPocketBase: a wrong sha256 throws 'checksum mismatch' and leaves nothing behind", async () => {
  const content = Buffer.from("payload", "utf8");
  const zip = buildZip("pocketbase", content, 0);

  const dir = makeDir();
  try {
    const targetBinary = join(dir, "bin", "pocketbase");
    await assert.rejects(
      () => downloadPocketBase({ url: "https://example.test/pb.zip", sha256: "0".repeat(64), file: "pb.zip" }, targetBinary, { fetch: fetchReturning(zip) }),
      /checksum mismatch/,
    );
    assert.equal(existsSync(targetBinary), false);
    // Nothing left in the target directory (no stray temp files either).
    assert.equal(existsSync(join(dir, "bin")) && readdirSync(join(dir, "bin")).length > 0, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadPocketBase: a non-ok HTTP response throws without writing anything", async () => {
  const dir = makeDir();
  try {
    const targetBinary = join(dir, "bin", "pocketbase");
    await assert.rejects(
      () => downloadPocketBase({ url: "https://example.test/pb.zip", sha256: "a".repeat(64), file: "pb.zip" }, targetBinary, { fetch: fetchReturning(Buffer.from(""), 404) }),
      /404/,
    );
    assert.equal(existsSync(targetBinary), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadPocketBase: supports a deflated entry too", async () => {
  const content = Buffer.from("x".repeat(300) + "deflate-friendly binary payload", "utf8");
  const zip = buildZip("pocketbase", content, 8);
  const sha256 = createHash("sha256").update(zip).digest("hex");

  const dir = makeDir();
  try {
    const targetBinary = join(dir, "bin", "pocketbase");
    await downloadPocketBase({ url: "https://example.test/pb.zip", sha256, file: "pb.zip" }, targetBinary, { fetch: fetchReturning(zip) });
    assert.deepEqual(readFileSync(targetBinary), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
