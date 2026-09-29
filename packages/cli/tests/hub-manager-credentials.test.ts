import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServiceAccount, useLocalHub, writeServiceAccount } from "../src/adapters/hub-manager/credentials.ts";

const LOCAL = { url: "http://127.0.0.1:8090", email: "kankaku-sync@kankaku.local", password: "svc-pass" };

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-hub-credentials-"));
}

function writeConfig(home: string, port = 8090): void {
  mkdirSync(join(home, ".kankaku", "hub"), { recursive: true });
  writeFileSync(join(home, ".kankaku", "hub", "hub.json"), JSON.stringify({ port, appVersion: "0.2.0", pocketbaseVersion: "0.40.4", installedAt: "2026-09-29T00:00:00.000Z" }));
}

function credentialsFile(home: string): string {
  return join(home, ".kankaku", "credentials.json");
}

test("writeServiceAccount: writes service.json 0600 and reads it back; a second identical write is a no-op", () => {
  const home = makeHome();
  try {
    assert.equal(readServiceAccount(home), undefined);
    assert.deepEqual(writeServiceAccount(home, LOCAL), { changed: true });
    const file = join(home, ".kankaku", "hub", "service.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), LOCAL);
    assert.deepEqual(readServiceAccount(home), LOCAL);
    assert.deepEqual(writeServiceAccount(home, LOCAL), { changed: false });
    assert.deepEqual(writeServiceAccount(home, { ...LOCAL, url: "http://127.0.0.1:8091" }), { changed: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readServiceAccount: a malformed service.json reads as absent", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".kankaku", "hub"), { recursive: true });
    writeFileSync(join(home, ".kankaku", "hub", "service.json"), "{nope");
    assert.equal(readServiceAccount(home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("useLocalHub: points credentials.json at the local hub, keeps a one-time 0600 .bak of the previous file and reports the previous url", () => {
  const home = makeHome();
  try {
    writeConfig(home);
    writeServiceAccount(home, LOCAL);
    const previous = JSON.stringify({ url: "https://hub.example.com", email: "me@example.com", password: "other" });
    writeFileSync(credentialsFile(home), previous);
    chmodSync(credentialsFile(home), 0o600);

    const result = useLocalHub(home);

    assert.deepEqual(result, { ok: true, changed: true, url: LOCAL.url, previousUrl: "https://hub.example.com" });
    const written = JSON.parse(readFileSync(credentialsFile(home), "utf8"));
    assert.deepEqual({ url: written.url, email: written.email, password: written.password }, LOCAL);
    assert.equal(statSync(credentialsFile(home)).mode & 0o777, 0o600);
    assert.equal(readFileSync(`${credentialsFile(home)}.bak`, "utf8"), previous);
    assert.equal(statSync(`${credentialsFile(home)}.bak`).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("useLocalHub: idempotent - a second run changes nothing and keeps the first .bak", () => {
  const home = makeHome();
  try {
    writeConfig(home);
    writeServiceAccount(home, LOCAL);
    const previous = JSON.stringify({ url: "https://hub.example.com", email: "me@example.com", password: "other" });
    writeFileSync(credentialsFile(home), previous);

    useLocalHub(home);
    const afterFirst = readFileSync(credentialsFile(home), "utf8");
    const second = useLocalHub(home);

    assert.deepEqual(second, { ok: true, changed: false, url: LOCAL.url, previousUrl: LOCAL.url });
    assert.equal(readFileSync(credentialsFile(home), "utf8"), afterFirst);
    assert.equal(readFileSync(`${credentialsFile(home)}.bak`, "utf8"), previous);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("useLocalHub: with no credentials.json yet it writes one and reports no previous url", () => {
  const home = makeHome();
  try {
    writeConfig(home);
    writeServiceAccount(home, LOCAL);
    const result = useLocalHub(home);
    assert.deepEqual(result, { ok: true, changed: true, url: LOCAL.url });
    assert.equal(existsSync(`${credentialsFile(home)}.bak`), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("useLocalHub: no local hub installed is an error that says how to install", () => {
  const home = makeHome();
  try {
    const result = useLocalHub(home);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /no local hub is installed.*kankaku hub install/);
    assert.equal(existsSync(credentialsFile(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("useLocalHub: an install without service.json is an error that says to run install again", () => {
  const home = makeHome();
  try {
    writeConfig(home);
    const previous = JSON.stringify({ url: "https://hub.example.com", email: "me@example.com", password: "other" });
    writeFileSync(credentialsFile(home), previous);

    const result = useLocalHub(home);

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /service\.json/);
    assert.match(result.ok ? "" : result.error, /kankaku hub install/);
    assert.equal(readFileSync(credentialsFile(home), "utf8"), previous);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
