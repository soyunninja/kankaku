import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentVersion, resolvePluginVersion } from "../src/adapters/agent-info.ts";

test("resolvePluginVersion reads the version field from package.json next to the package root", () => {
  const files = new Map([["/pkg/package.json", JSON.stringify({ name: "kankaku", version: "1.2.3" })]]);
  const version = resolvePluginVersion("/pkg", { readFile: (path) => files.get(path) ?? "" });
  assert.equal(version, "1.2.3");
});

test("resolvePluginVersion returns undefined (never guesses) when the file is missing or malformed", () => {
  assert.equal(
    resolvePluginVersion("/nope", {
      readFile: () => {
        throw new Error("ENOENT");
      },
    }),
    undefined,
  );
  assert.equal(
    resolvePluginVersion("/bad", { readFile: () => "not json" }),
    undefined,
  );
  assert.equal(
    resolvePluginVersion("/no-version", { readFile: () => JSON.stringify({ name: "kankaku" }) }),
    undefined,
  );
});

test("resolveAgentVersion reads the version from the resolved package's own package.json", () => {
  const files = new Map([
    ["/deps/pi-coding-agent/package.json", JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1" })],
  ]);
  const version = resolveAgentVersion({
    resolveModule: () => "file:///deps/pi-coding-agent/dist/index.js",
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
  });
  assert.equal(version, "0.85.1");
});

test("resolveAgentVersion walks up from a nested entry file to find the package's own package.json", () => {
  const files = new Map([
    ["/deps/pi-coding-agent/package.json", JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1" })],
  ]);
  const version = resolveAgentVersion({
    resolveModule: () => "file:///deps/pi-coding-agent/dist/bundle/chunks/index.js",
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
  });
  assert.equal(version, "0.85.1");
});

test("resolveAgentVersion never trusts a package.json belonging to a different package name", () => {
  const files = new Map([["/deps/pi-coding-agent/package.json", JSON.stringify({ name: "some-other-package", version: "9.9.9" })]]);
  const version = resolveAgentVersion({
    resolveModule: () => "file:///deps/pi-coding-agent/dist/index.js",
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
  });
  assert.equal(version, undefined);
});

test("resolveAgentVersion returns undefined (never guesses) when module resolution itself fails", () => {
  const version = resolveAgentVersion({
    resolveModule: () => {
      throw new Error("not found");
    },
  });
  assert.equal(version, undefined);
});
