import { test } from "node:test";
import assert from "node:assert/strict";
import { settleCost } from "../src/cost-chain.ts";

test("settleCost: cost is total minus start, rounded to micro-dollars, and the baseline becomes the total", () => {
  assert.deepEqual(settleCost(0.4, 0.1), { cost: 0.3, baseline: 0.4 });
  assert.deepEqual(settleCost(7, 6), { cost: 1, baseline: 7 });
});

test("settleCost: a total below the start means the counter was reset, so cost is the total", () => {
  assert.deepEqual(settleCost(0.5, 7), { cost: 0.5, baseline: 0.5 });
});

test("settleCost: an equal total costs zero", () => {
  assert.deepEqual(settleCost(2, 2), { cost: 0, baseline: 2 });
});

test("settleCost: no finite total leaves cost unobserved and the baseline untouched", () => {
  assert.deepEqual(settleCost(undefined, 1), {});
  assert.deepEqual(settleCost(Number.NaN, 1), {});
  assert.deepEqual(settleCost(Number.POSITIVE_INFINITY, 1), {});
});

test("settleCost: a total with no start yet leaves cost unobserved but starts the chain", () => {
  assert.deepEqual(settleCost(3, undefined), { baseline: 3 });
});
