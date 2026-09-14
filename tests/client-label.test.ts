import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveClient, resolveClientSource } from "../src/domain/client-label.ts";

test("resolveClient prefers session over env over project", () => {
  assert.equal(resolveClient({ session: "acme", env: "globex", project: "initech" }), "acme");
  assert.equal(resolveClient({ env: "globex", project: "initech" }), "globex");
  assert.equal(resolveClient({ project: "initech" }), "initech");
});

test("resolveClient returns undefined when no source is present", () => {
  assert.equal(resolveClient({}), undefined);
});

test("resolveClient trims whitespace", () => {
  assert.equal(resolveClient({ session: "  acme  " }), "acme");
});

test("resolveClient treats an empty or whitespace-only string as absent, falling to the next source", () => {
  assert.equal(resolveClient({ session: "", env: "globex" }), "globex");
  assert.equal(resolveClient({ session: "   ", env: "globex" }), "globex");
});

test("resolveClient rejects a value that does not match the safe pattern, falling to the next source", () => {
  assert.equal(resolveClient({ session: "acme corp", env: "globex" }), "globex");
  assert.equal(resolveClient({ session: "acme/corp", env: "globex" }), "globex");
  assert.equal(resolveClient({ session: "a".repeat(65), env: "globex" }), "globex");
});

test("resolveClient accepts letters, digits, dot, underscore and hyphen up to 64 chars", () => {
  const name = "Acme-Corp_2.io";
  assert.equal(resolveClient({ session: name }), name);
  const maxLength = "a".repeat(64);
  assert.equal(resolveClient({ session: maxLength }), maxLength);
});

test("resolveClient rejects a reserved property name such as __proto__ or constructor", () => {
  assert.equal(resolveClient({ session: "__proto__", env: "globex" }), "globex");
  assert.equal(resolveClient({ session: "constructor", env: "globex" }), "globex");
});

test("resolveClientSource reports which source won, or undefined when none applies", () => {
  assert.equal(resolveClientSource({ session: "acme", env: "globex" }), "session");
  assert.equal(resolveClientSource({ env: "globex", project: "initech" }), "env");
  assert.equal(resolveClientSource({ project: "initech" }), "project");
  assert.equal(resolveClientSource({}), undefined);
  assert.equal(resolveClientSource({ session: "bad name", project: "initech" }), "project");
});
