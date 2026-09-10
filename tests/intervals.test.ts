import assert from "node:assert/strict";
import { test } from "node:test";
import { clampIntervals, unionMs } from "../src/domain/intervals.ts";

test("unionMs of an empty list is zero", () => {
  assert.equal(unionMs([]), 0);
});

test("unionMs of disjoint intervals sums each span", () => {
  const total = unionMs([
    { start: 0, end: 100 },
    { start: 200, end: 250 },
  ]);
  assert.equal(total, 150);
});

test("unionMs of overlapping intervals merges instead of summing", () => {
  const total = unionMs([
    { start: 0, end: 100 },
    { start: 50, end: 200 },
  ]);
  assert.equal(total, 200);
});

test("unionMs of a nested interval counts only the outer span", () => {
  const total = unionMs([
    { start: 0, end: 300 },
    { start: 50, end: 100 },
  ]);
  assert.equal(total, 300);
});

test("unionMs of touching intervals merges the boundary without double counting", () => {
  const total = unionMs([
    { start: 0, end: 100 },
    { start: 100, end: 200 },
  ]);
  assert.equal(total, 200);
});

test("unionMs ignores input order", () => {
  const total = unionMs([
    { start: 200, end: 250 },
    { start: 0, end: 100 },
  ]);
  assert.equal(total, 150);
});

test("clampIntervals restricts intervals to the given window and drops empty results", () => {
  const clamped = clampIntervals(
    [
      { start: -50, end: 50 },
      { start: 80, end: 120 },
      { start: 200, end: 300 },
    ],
    0,
    100,
  );

  assert.deepEqual(clamped, [
    { start: 0, end: 50 },
    { start: 80, end: 100 },
  ]);
});
