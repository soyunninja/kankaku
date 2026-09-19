import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveHubCredentials } from "../src/adapters/hub-credentials.ts";

function makeHomeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-hub-credentials-"));
}

function writeCredentialsFile(homeDir: string, content: unknown): void {
  const dir = join(homeDir, ".kankaku");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "credentials.json"), typeof content === "string" ? content : JSON.stringify(content));
}

test("resolveHubCredentials returns undefined when nothing is configured", () => {
  const homeDir = makeHomeDir();
  try {
    const result = resolveHubCredentials({ env: {}, homeDir });
    assert.equal(result.credentials, undefined);
    assert.equal(result.invalidReason, undefined);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveHubCredentials reads the credentials file when env is unset", () => {
  const homeDir = makeHomeDir();
  try {
    writeCredentialsFile(homeDir, { url: "https://pb.example.com", email: "bot@example.com", password: "secret" });
    const result = resolveHubCredentials({ env: {}, homeDir });
    assert.deepEqual(result.credentials, { url: "https://pb.example.com", email: "bot@example.com", password: "secret" });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveHubCredentials prefers env fields over the file, field by field", () => {
  const homeDir = makeHomeDir();
  try {
    writeCredentialsFile(homeDir, { url: "https://file.example.com", email: "file@example.com", password: "filepass" });
    const result = resolveHubCredentials({
      env: { KANKAKU_PB_URL: "https://env.example.com" },
      homeDir,
    });
    assert.deepEqual(result.credentials, { url: "https://env.example.com", email: "file@example.com", password: "filepass" });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveHubCredentials tolerates a missing credentials file", () => {
  const homeDir = makeHomeDir();
  try {
    const result = resolveHubCredentials({
      env: { KANKAKU_PB_URL: "https://env.example.com", KANKAKU_PB_EMAIL: "a@b.com", KANKAKU_PB_PASSWORD: "x" },
      homeDir,
    });
    assert.deepEqual(result.credentials, { url: "https://env.example.com", email: "a@b.com", password: "x" });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveHubCredentials tolerates malformed JSON in the credentials file", () => {
  const homeDir = makeHomeDir();
  try {
    writeCredentialsFile(homeDir, "{not json");
    const result = resolveHubCredentials({ env: {}, homeDir });
    assert.equal(result.credentials, undefined);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveHubCredentials returns undefined when only some fields resolve", () => {
  const homeDir = makeHomeDir();
  try {
    const result = resolveHubCredentials({ env: { KANKAKU_PB_URL: "https://env.example.com" }, homeDir });
    assert.equal(result.credentials, undefined);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveHubCredentials reports invalidReason and no credentials for a refused URL", () => {
  const homeDir = makeHomeDir();
  try {
    const result = resolveHubCredentials({
      env: { KANKAKU_PB_URL: "http://pb.example.com", KANKAKU_PB_EMAIL: "a@b.com", KANKAKU_PB_PASSWORD: "x" },
      homeDir,
    });
    assert.equal(result.credentials, undefined);
    assert.match(result.invalidReason ?? "", /refusing non-HTTPS/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
