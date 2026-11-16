import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  solvePrices,
  recordSample,
  priceUsage,
  readPriceBook,
  writePriceBook,
  priceBookFile,
  learnFromTranscript,
  emptyPriceBook,
  type PriceSample,
} from "../src/price-book.ts";
import { zeroCategories, type CategoryUsage } from "../src/transcript.ts";

// Prices of a made-up model, USD per million tokens.
const RATES = { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 };

function tokens(partial: Partial<CategoryUsage>): CategoryUsage {
  return { ...zeroCategories(), ...partial };
}

function costOf(t: CategoryUsage, rates: Partial<Record<keyof CategoryUsage, number>> = RATES): number {
  let usd = 0;
  for (const [key, count] of Object.entries(t)) usd += (count * (rates[key as keyof CategoryUsage] ?? 0)) / 1e6;
  return usd;
}

function sample(sessionId: string, t: Partial<CategoryUsage>, rates = RATES): PriceSample {
  const full = tokens(t);
  return { sessionId, at: 1, tokens: full, costUsd: costOf(full, rates) };
}

const SIX = [
  sample("s1", { input: 1000, output: 2000, cacheRead: 300000, cacheWrite5m: 1000, cacheWrite1h: 40000 }),
  sample("s2", { input: 5000, output: 100, cacheRead: 10000, cacheWrite5m: 7000, cacheWrite1h: 1000 }),
  sample("s3", { input: 200, output: 9000, cacheRead: 50000, cacheWrite5m: 0, cacheWrite1h: 80000 }),
  sample("s4", { input: 7000, output: 3000, cacheRead: 900000, cacheWrite5m: 20000, cacheWrite1h: 5000 }),
  sample("s5", { input: 300, output: 600, cacheRead: 1000, cacheWrite5m: 100, cacheWrite1h: 100 }),
  sample("s6", { input: 900, output: 4000, cacheRead: 70000, cacheWrite5m: 3000, cacheWrite1h: 12000 }),
];

function close(actual: number | undefined, expected: number): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
}

test("solvePrices finds each category's price per million tokens when every sample is reproduced", () => {
  const prices = solvePrices(SIX);
  assert.ok(prices);
  close(prices.input, 4);
  close(prices.output, 20);
  close(prices.cacheRead, 0.2);
  close(prices.cacheWrite5m, 5);
  close(prices.cacheWrite1h, 8);
});

test("solvePrices prices only the categories it has seen", () => {
  const only1h = [1, 2, 3, 4, 5].map((n) => sample(`s${n}`, { input: 100 * n, output: 70 + n * n * 10, cacheRead: 5000 / n, cacheWrite1h: 900 * n * n }));
  const prices = solvePrices(only1h);
  assert.ok(prices);
  assert.equal(prices.cacheWrite5m, undefined);
  close(prices.cacheWrite1h, 8);
});

test("solvePrices refuses too few samples, samples it cannot reproduce, and negative prices", () => {
  assert.equal(solvePrices(SIX.slice(0, 5)), undefined);
  const noisy = SIX.map((s: PriceSample, i: number) => (i === 2 ? { ...s, costUsd: s.costUsd * 1.05 } : s));
  assert.equal(solvePrices(noisy), undefined);
  assert.equal(solvePrices(SIX.map((s: PriceSample) => ({ ...s, tokens: { ...s.tokens, cacheWriteUnsplit: 10 } }))), undefined);
  // Costs only a negative price would reproduce.
  assert.equal(solvePrices(SIX.map((s: PriceSample) => ({ ...s, costUsd: costOf(s.tokens, { ...RATES, input: -1 }) }))), undefined);
  // The same samples twice are not independent: nothing is solved.
  assert.equal(solvePrices([SIX[0]!, SIX[0]!, SIX[0]!, SIX[0]!, SIX[0]!, SIX[0]!]), undefined);
});

test("recordSample keeps one sample per session, the last 30 per model, and solves the prices", () => {
  let book = emptyPriceBook();
  for (const s of SIX) book = recordSample(book, "model-a", s, 100);
  close(book.models["model-a"]?.prices?.output, 20);

  const again = recordSample(book, "model-a", { ...SIX[0]!, at: 2 }, 200);
  assert.equal(again.models["model-a"]?.samples.length, 6);
  assert.equal(again.models["model-a"]?.samples.at(-1)?.at, 2);

  let many = book;
  // Independent-looking counts (a fixed pseudo-random walk), so the last 30 still solve the prices.
  for (let n = 0; n < 40; n += 1) {
    const r = (k: number) => ((n + 1) * 7919 * (k + 3)) % 9973;
    many = recordSample(many, "model-a", sample(`x${n}`, { input: r(1), output: r(2) % 4001, cacheRead: r(3) * 50, cacheWrite5m: r(4) % 3001, cacheWrite1h: r(5) % 7001 }), 300);
  }
  assert.equal(many.models["model-a"]?.samples.length, 30);
  close(many.models["model-a"]?.prices?.cacheRead, 0.2);
});

test("recordSample keeps prices that reproduce every sample when the samples alone cannot solve them again", () => {
  const book = { version: 1 as const, models: { "model-a": { samples: [], prices: { input: 4, output: 20 } } } };
  const next = recordSample(book, "model-a", sample("s1", { input: 1000, output: 1000 }), 100);
  assert.deepEqual(next.models["model-a"]?.prices, { input: 4, output: 20 });
  assert.equal(next.models["model-a"]?.samples.length, 1);
});

test("recordSample treats a sample the prices no longer reproduce as a price change: older samples go, prices clear, the date is kept", () => {
  let book = emptyPriceBook();
  for (const s of SIX) book = recordSample(book, "model-a", s, 100);
  const raised = sample("s9", { input: 1000, output: 1000, cacheRead: 1000, cacheWrite5m: 1000, cacheWrite1h: 1000 }, { ...RATES, output: 25 });
  const changed = recordSample(book, "model-a", raised, 500);
  assert.equal(changed.models["model-a"]?.prices, undefined);
  assert.equal(changed.models["model-a"]?.changedAt, 500);
  assert.deepEqual(changed.models["model-a"]?.samples.map((s: PriceSample) => s.sessionId), ["s9"]);
});

test("priceUsage prices a prompt only when every model and category with tokens has a price", () => {
  let book = emptyPriceBook();
  for (const s of SIX) book = recordSample(book, "model-a", s, 100);
  close(priceUsage(book, { "model-a": tokens({ input: 1_000_000, output: 1_000_000, cacheWrite1h: 500_000 }) }), 28);
  assert.equal(priceUsage(book, { "model-a": tokens({ output: 10, cacheWriteUnsplit: 5 }) }), undefined);
  assert.equal(priceUsage(book, { "model-a": tokens({ output: 10 }), "model-b": tokens({ output: 10 }) }), undefined);
  assert.equal(priceUsage(book, undefined), undefined);
  assert.equal(priceUsage(emptyPriceBook(), { "model-a": tokens({ output: 10 }) }), undefined);
});

test("the price book lives under HOME; a missing or malformed file reads as empty", () => {
  const home = mkdtempSync(join(tmpdir(), "kankaku-prices-home-"));
  try {
    const env = { HOME: home };
    assert.equal(priceBookFile(env), join(home, ".kankaku", "claude", "prices.json"));
    assert.deepEqual(readPriceBook(env), emptyPriceBook());
    let book = emptyPriceBook();
    for (const s of SIX) book = recordSample(book, "model-a", s, 100);
    writePriceBook(env, book);
    assert.deepEqual(readPriceBook(env), book);
    writeFileSync(priceBookFile(env), "{not json");
    assert.deepEqual(readPriceBook(env), emptyPriceBook());
    writeFileSync(priceBookFile(env), JSON.stringify({ version: 1, models: { m: { samples: "nope" } } }));
    assert.deepEqual(readPriceBook(env), emptyPriceBook());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Synthetic transcript lines: only the shapes.
function message(id: string, model: string, t: Partial<CategoryUsage>): string {
  const u = tokens(t);
  return `${JSON.stringify({
    type: "assistant",
    message: {
      id,
      model,
      usage: {
        input_tokens: u.input,
        output_tokens: u.output,
        cache_read_input_tokens: u.cacheRead,
        cache_creation_input_tokens: u.cacheWrite5m + u.cacheWrite1h,
        cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite5m, ephemeral_1h_input_tokens: u.cacheWrite1h },
      },
    },
  })}\n`;
}

function costState(models: Record<string, { t: CategoryUsage; cost: number }>, unknown = false): string {
  const modelUsage: Record<string, unknown> = {};
  for (const [model, { t, cost }] of Object.entries(models)) {
    modelUsage[model] = { inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.cacheRead, cacheCreationInputTokens: t.cacheWrite5m + t.cacheWrite1h, costUSD: cost };
  }
  return `${JSON.stringify({ type: "cost-state", totalCostUSD: 1, hasUnknownModelCost: unknown, modelUsage })}\n`;
}

test("learnFromTranscript stores one sample per model whose transcript totals match the cost-state, counting subagent files", () => {
  const home = mkdtempSync(join(tmpdir(), "kankaku-learn-home-"));
  const dir = mkdtempSync(join(tmpdir(), "kankaku-learn-"));
  try {
    const env = { HOME: home };
    const main = join(dir, "sess.jsonl");
    const subDir = join(dir, "sess", "subagents");
    mkdirSync(subDir, { recursive: true });
    const a1 = tokens({ input: 10, output: 20, cacheWrite1h: 30 });
    const sub = tokens({ input: 1, output: 2, cacheWrite5m: 3 });
    const b = tokens({ input: 5, output: 5 });
    writeFileSync(join(subDir, "agent-1.jsonl"), message("s1", "model-a", sub));
    const aTotal = tokens({ input: 11, output: 22, cacheWrite5m: 3, cacheWrite1h: 30 });
    writeFileSync(
      main,
      message("m1", "model-a", a1) +
        message("m2", "model-b", b) +
        // model-c's counts in the cost-state do not match the transcript: no sample.
        message("m3", "model-c", tokens({ output: 9 })) +
        costState({ "model-a": { t: aTotal, cost: 0.5 }, "model-b": { t: b, cost: 0.25 }, "model-c": { t: tokens({ output: 99 }), cost: 1 } }),
    );

    assert.deepEqual(learnFromTranscript(main, "sess", env, 1000).sort(), ["model-a", "model-b"]);
    const book = readPriceBook(env);
    assert.deepEqual(book.models["model-a"]?.samples, [{ sessionId: "sess", at: 1000, tokens: aTotal, costUsd: 0.5 }]);
    assert.deepEqual(book.models["model-b"]?.samples, [{ sessionId: "sess", at: 1000, tokens: b, costUsd: 0.25 }]);
    assert.equal(book.models["model-c"], undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("learnFromTranscript matches a cost-state model with a bracket suffix to the transcript's plain model name, unless that is ambiguous", () => {
  const home = mkdtempSync(join(tmpdir(), "kankaku-learn-home-"));
  const dir = mkdtempSync(join(tmpdir(), "kankaku-learn-"));
  try {
    const env = { HOME: home };
    const main = join(dir, "sess.jsonl");
    const a = tokens({ input: 10, output: 20, cacheWrite1h: 30 });
    writeFileSync(main, message("m1", "model-a", a) + costState({ "model-a[1m]": { t: a, cost: 0.5 } }));
    assert.deepEqual(learnFromTranscript(main, "sess", env, 1000), ["model-a"]);
    assert.equal(readPriceBook(env).models["model-a"]?.samples.length, 1);
    assert.equal(readPriceBook(env).models["model-a[1m]"], undefined);

    // Both the plain and the suffixed name in the cost-state: the suffixed one cannot be told apart.
    const ambiguous = join(dir, "amb.jsonl");
    writeFileSync(ambiguous, message("m1", "model-b", a) + costState({ "model-b": { t: a, cost: 0.5 }, "model-b[1m]": { t: a, cost: 0.5 } }));
    assert.deepEqual(learnFromTranscript(ambiguous, "amb", env, 1000), ["model-b"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("learnFromTranscript learns nothing without a cost-state, from one that flags an unknown model cost, or from a missing file", () => {
  const home = mkdtempSync(join(tmpdir(), "kankaku-learn-home-"));
  const dir = mkdtempSync(join(tmpdir(), "kankaku-learn-"));
  try {
    const env = { HOME: home };
    const main = join(dir, "sess.jsonl");
    const a = tokens({ input: 10, output: 20 });
    writeFileSync(main, message("m1", "model-a", a));
    assert.deepEqual(learnFromTranscript(main, "sess", env, 1000), []);
    writeFileSync(main, message("m1", "model-a", a) + costState({ "model-a": { t: a, cost: 0.5 } }, true));
    assert.deepEqual(learnFromTranscript(main, "sess", env, 1000), []);
    assert.deepEqual(learnFromTranscript(join(dir, "missing.jsonl"), "x", env, 1000), []);
    assert.equal(existsSync(priceBookFile(env)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the price book file holds only numbers, model names and session ids", () => {
  const home = mkdtempSync(join(tmpdir(), "kankaku-prices-home-"));
  try {
    const env = { HOME: home };
    let book = emptyPriceBook();
    for (const s of SIX) book = recordSample(book, "model-a", s, 100);
    writePriceBook(env, book);
    const parsed = JSON.parse(readFileSync(priceBookFile(env), "utf8"));
    assert.deepEqual(Object.keys(parsed).sort(), ["models", "version"]);
    assert.deepEqual(Object.keys(parsed.models["model-a"]).sort(), ["prices", "samples"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
