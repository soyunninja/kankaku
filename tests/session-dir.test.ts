import assert from "node:assert/strict";
import { test } from "node:test";
import { readNonDefaultSessionDir } from "../src/adapters/session-dir.ts";

test("returns the session dir when usesDefaultSessionDir reports false", () => {
  const sessionManager = { usesDefaultSessionDir: () => false, getSessionDir: () => "/custom/session/dir" };
  assert.equal(readNonDefaultSessionDir(sessionManager), "/custom/session/dir");
});

test("returns undefined when usesDefaultSessionDir reports true", () => {
  const sessionManager = { usesDefaultSessionDir: () => true, getSessionDir: () => "/default/session/dir" };
  assert.equal(readNonDefaultSessionDir(sessionManager), undefined);
});

test("returns undefined when the session manager lacks either method (older pi version)", () => {
  assert.equal(readNonDefaultSessionDir({}), undefined);
  assert.equal(readNonDefaultSessionDir({ getSessionDir: () => "/x" }), undefined);
  assert.equal(readNonDefaultSessionDir({ usesDefaultSessionDir: () => false }), undefined);
});

test("returns undefined (never throws) when usesDefaultSessionDir itself throws", () => {
  const sessionManager = {
    usesDefaultSessionDir: () => {
      throw new Error("boom");
    },
    getSessionDir: () => "/x",
  };
  assert.doesNotThrow(() => readNonDefaultSessionDir(sessionManager));
  assert.equal(readNonDefaultSessionDir(sessionManager), undefined);
});

test("returns undefined when usesDefaultSessionDir is false but getSessionDir is empty (e.g. an unpersisted --no-session run)", () => {
  const sessionManager = { usesDefaultSessionDir: () => false, getSessionDir: () => "" };
  assert.equal(readNonDefaultSessionDir(sessionManager), undefined);
});

test("returns undefined (never throws) when getSessionDir itself throws", () => {
  const sessionManager = {
    usesDefaultSessionDir: () => false,
    getSessionDir: () => {
      throw new Error("boom");
    },
  };
  assert.equal(readNonDefaultSessionDir(sessionManager), undefined);
});
