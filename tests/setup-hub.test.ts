import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHubHealth, credentialsPath, writeHubCredentials } from "../src/adapters/setup/hub.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-setup-hub-"));
}

test("writeHubCredentials: creates ~/.kankaku (0700) and credentials.json (0600) when neither exists", () => {
  const home = makeHome();
  try {
    const result = writeHubCredentials(home, { url: "https://hub.example.com", email: "a@b.com", password: "secret" });
    assert.equal(result.changed, true);

    const filePath = credentialsPath(home);
    const written = JSON.parse(readFileSync(filePath, "utf8"));
    assert.deepEqual(written, { url: "https://hub.example.com", email: "a@b.com", password: "secret" });

    assert.equal(statSync(join(home, ".kankaku")).mode & 0o777, 0o700);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeHubCredentials: never chmods an already-existing ~/.kankaku directory", () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".kankaku"), { recursive: true, mode: 0o755 });
    writeHubCredentials(home, { url: "https://hub.example.com", email: "a@b.com", password: "secret" });
    assert.equal(statSync(join(home, ".kankaku")).mode & 0o777, 0o755);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeHubCredentials: is a no-op when the values already match", () => {
  const home = makeHome();
  try {
    writeHubCredentials(home, { url: "https://hub.example.com", email: "a@b.com", password: "secret" });
    const before = readFileSync(credentialsPath(home), "utf8");

    const result = writeHubCredentials(home, { url: "https://hub.example.com", email: "a@b.com", password: "secret" });
    assert.equal(result.changed, false);
    assert.equal(readFileSync(credentialsPath(home), "utf8"), before);
    assert.equal(existsSync(`${credentialsPath(home)}.bak`), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeHubCredentials: backs up the previous credentials.json before overwriting", () => {
  const home = makeHome();
  try {
    writeHubCredentials(home, { url: "https://old.example.com", email: "a@b.com", password: "old-secret" });
    const originalText = readFileSync(credentialsPath(home), "utf8");

    writeHubCredentials(home, { url: "https://new.example.com", email: "a@b.com", password: "new-secret" });

    assert.equal(readFileSync(`${credentialsPath(home)}.bak`, "utf8"), originalText);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>): typeof fetch {
  return ((url: string, init?: RequestInit) => handler(url, init)) as typeof fetch;
}

test("checkHubHealth: true when GET <url>/api/health resolves ok", async () => {
  let seenUrl = "";
  const ok = await checkHubHealth("https://hub.example.com/", {
    fetch: fakeFetch(async (url) => {
      seenUrl = url;
      return new Response(null, { status: 200 });
    }),
  });
  assert.equal(ok, true);
  assert.equal(seenUrl, "https://hub.example.com/api/health");
});

test("checkHubHealth: false on a non-ok response", async () => {
  const ok = await checkHubHealth("https://hub.example.com", { fetch: fakeFetch(async () => new Response(null, { status: 500 })) });
  assert.equal(ok, false);
});

test("checkHubHealth: false when fetch rejects (network error)", async () => {
  const ok = await checkHubHealth("https://hub.example.com", {
    fetch: fakeFetch(async () => {
      throw new Error("network down");
    }),
  });
  assert.equal(ok, false);
});

test("checkHubHealth: false when the request does not settle before the timeout, and it aborts the fetch", async () => {
  let aborted = false;
  const ok = await checkHubHealth("https://hub.example.com", {
    timeoutMs: 5,
    fetch: fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    ),
  });
  assert.equal(ok, false);
  assert.equal(aborted, true);
});
