import assert from "node:assert/strict";
import { test } from "node:test";
import { localDay } from "../src/domain/day.ts";

test("localDay renders the local calendar day of an ISO timestamp as YYYY-MM-DD", () => {
  const date = new Date(2026, 8, 10, 23, 30); // local Sep 10, 2026, 23:30
  assert.equal(localDay(date.toISOString()), "2026-09-10");
});

test("localDay pads single-digit month and day", () => {
  const date = new Date(2026, 0, 5, 10, 0); // local Jan 5, 2026
  assert.equal(localDay(date.toISOString()), "2026-01-05");
});
