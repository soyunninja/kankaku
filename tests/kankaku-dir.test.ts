import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveKankakuDir } from "../src/adapters/kankaku-dir.ts";

test("resolveKankakuDir joins a relative dir against the cwd", () => {
  assert.equal(resolveKankakuDir(".kankaku", "/work/project"), "/work/project/.kankaku");
});

test("resolveKankakuDir keeps an absolute dir as-is", () => {
  assert.equal(resolveKankakuDir("/var/kankaku", "/work/project"), "/var/kankaku");
});
