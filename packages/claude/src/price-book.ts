import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listSubagentTranscripts, readTranscriptSince, PRICE_CATEGORIES, zeroCategories, type CategoryUsage } from "./transcript.ts";

/**
 * Prices learned from Claude Code's own session totals, for sessions that
 * have no statusline (desktop app, IDE). A closed session's `cost-state`
 * line gives, per model, a cost and token counts; the transcript gives the
 * same tokens split the way they are priced. Enough of those samples solve
 * each model's price per category. Nothing is maintained by hand: a model
 * is priced once its samples agree, and loses its prices the moment a new
 * sample disagrees (the price changed), until it is relearned.
 *
 * Lives under HOME (`~/.kankaku/claude/prices.json`), never a project, and
 * holds only model names, session ids and numbers. Node builtins only.
 */

/** A category that can carry a price: every one except the unsplit cache write. */
export type PricedCategory = Exclude<keyof CategoryUsage, "cacheWriteUnsplit">;

/** USD per million tokens, for the categories seen so far. */
export type PricesPerMtok = Partial<Record<PricedCategory, number>>;

export interface PriceSample {
  sessionId: string;
  /** Epoch ms of the learn. */
  at: number;
  tokens: CategoryUsage;
  costUsd: number;
}

export interface ModelPrices {
  samples: PriceSample[];
  prices?: PricesPerMtok;
  /** Epoch ms of the last sample the prices did not reproduce (the price changed). */
  changedAt?: number;
}

export interface PriceBook {
  version: 1;
  models: Record<string, ModelPrices>;
}

/** Samples kept per model. */
export const MAX_SAMPLES = 30;
/** A sample is reproduced when the priced cost is within this share of its real cost. */
export const PRICE_TOLERANCE = 0.001;
/** Most bytes read across a session's transcript files to learn from it (128 MiB). */
export const LEARN_MAX_BYTES = 128 * 1024 * 1024;

const PRICED: readonly PricedCategory[] = PRICE_CATEGORIES.filter((c): c is PricedCategory => c !== "cacheWriteUnsplit");

export function emptyPriceBook(): PriceBook {
  return { version: 1, models: {} };
}

export function priceBookFile(env: { HOME?: string }): string {
  return join(env.HOME || homedir(), ".kankaku", "claude", "prices.json");
}

/** USD for `tokens` at `prices`, or `undefined` when a category with tokens has no price. */
function costAt(prices: PricesPerMtok, tokens: CategoryUsage): number | undefined {
  if (tokens.cacheWriteUnsplit > 0) return undefined;
  let usd = 0;
  for (const category of PRICED) {
    const count = tokens[category];
    if (count === 0) continue;
    const price = prices[category];
    if (price === undefined) return undefined;
    usd += (count * price) / 1e6;
  }
  return usd;
}

function reproduces(prices: PricesPerMtok, sample: PriceSample): boolean {
  const usd = costAt(prices, sample.tokens);
  return usd !== undefined && Math.abs(usd - sample.costUsd) <= Math.max(PRICE_TOLERANCE * sample.costUsd, 1e-9);
}

/**
 * Least squares over the samples, one unknown per category that has tokens.
 * `undefined` unless there is at least one more sample than unknowns, the
 * system is solvable, no price is negative and every sample is reproduced.
 */
export function solvePrices(samples: readonly PriceSample[]): PricesPerMtok | undefined {
  if (samples.some((s) => s.tokens.cacheWriteUnsplit > 0)) return undefined;
  const unknowns = PRICED.filter((category) => samples.some((s) => s.tokens[category] > 0));
  const n = unknowns.length;
  if (n === 0 || samples.length < n + 1) return undefined;

  const rows = samples.map((s) => unknowns.map((category) => s.tokens[category] / 1e6));
  const matrix = unknowns.map((_, i) => [
    ...unknowns.map((__, j) => rows.reduce((sum, row) => sum + row[i]! * row[j]!, 0)),
    rows.reduce((sum, row, k) => sum + row[i]! * samples[k]!.costUsd, 0),
  ]);
  const scale = Math.max(...matrix.map((row, i) => Math.abs(row[i]!)));
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(matrix[r]![col]!) > Math.abs(matrix[pivot]![col]!)) pivot = r;
    if (!(Math.abs(matrix[pivot]![col]!) > 1e-12 * scale)) return undefined;
    [matrix[col], matrix[pivot]] = [matrix[pivot]!, matrix[col]!];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = matrix[r]![col]! / matrix[col]![col]!;
      for (let c = col; c <= n; c += 1) matrix[r]![c] = matrix[r]![c]! - factor * matrix[col]![c]!;
    }
  }

  const prices: PricesPerMtok = {};
  for (let i = 0; i < n; i += 1) {
    const value = matrix[i]![n]! / matrix[i]![i]!;
    if (!Number.isFinite(value) || value < -1e-9) return undefined;
    prices[unknowns[i]!] = Math.max(0, value);
  }
  return samples.every((s) => reproduces(prices, s)) ? prices : undefined;
}

/**
 * Pure: adds one session's sample for `model`. A sample the current prices
 * price but do not reproduce means the price changed: the older samples
 * are dropped, the prices cleared and `changedAt` set to `now`. Otherwise
 * the session's earlier sample is replaced, the last {@link MAX_SAMPLES}
 * are kept and the prices are solved again; when they cannot be, prices
 * that still reproduce every sample they can price are kept.
 */
export function recordSample(book: PriceBook, model: string, sample: PriceSample, now: number): PriceBook {
  const entry = book.models[model] ?? { samples: [] };
  let next: ModelPrices;
  if (entry.prices && costAt(entry.prices, sample.tokens) !== undefined && !reproduces(entry.prices, sample)) {
    next = { samples: [sample], changedAt: now };
  } else {
    const samples = [...entry.samples.filter((s) => s.sessionId !== sample.sessionId), sample].slice(-MAX_SAMPLES);
    // Prices that still reproduce every sample they can price are kept when the samples alone do not solve them again.
    const kept = entry.prices && samples.every((s) => costAt(entry.prices!, s.tokens) === undefined || reproduces(entry.prices!, s)) ? entry.prices : undefined;
    const prices = solvePrices(samples) ?? kept;
    next = { samples, ...(prices ? { prices } : {}), ...(entry.changedAt !== undefined ? { changedAt: entry.changedAt } : {}) };
  }
  return { ...book, models: { ...book.models, [model]: next } };
}

/**
 * USD for one prompt's tokens per model, or `undefined` unless every model
 * and category with tokens has a learned price. Never a partial figure.
 */
export function priceUsage(book: PriceBook, byModel: Record<string, CategoryUsage> | undefined): number | undefined {
  if (!byModel) return undefined;
  let usd = 0;
  let any = false;
  for (const [model, tokens] of Object.entries(byModel)) {
    if (Object.values(tokens).every((count) => count === 0)) continue;
    const prices = book.models[model]?.prices;
    const cost = prices ? costAt(prices, tokens) : undefined;
    if (cost === undefined) return undefined;
    usd += cost;
    any = true;
  }
  return any ? usd : undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSample(value: unknown): value is PriceSample {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !isCount(value.at) || !isCount(value.costUsd)) return false;
  const tokens = value.tokens;
  return isRecord(tokens) && PRICE_CATEGORIES.every((category) => isCount(tokens[category]));
}

function isModelPrices(value: unknown): value is ModelPrices {
  if (!isRecord(value) || !Array.isArray(value.samples) || !value.samples.every(isSample)) return false;
  if (value.changedAt !== undefined && !isCount(value.changedAt)) return false;
  const prices = value.prices;
  return prices === undefined || (isRecord(prices) && Object.entries(prices).every(([key, price]) => (PRICED as readonly string[]).includes(key) && isCount(price)));
}

/** The stored book, or an empty one when the file is missing or anything in it is malformed. */
export function readPriceBook(env: { HOME?: string }): PriceBook {
  try {
    const parsed: unknown = JSON.parse(readFileSync(priceBookFile(env), "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.models)) return emptyPriceBook();
    if (!Object.values(parsed.models).every(isModelPrices)) return emptyPriceBook();
    return { version: 1, models: parsed.models as Record<string, ModelPrices> };
  } catch {
    return emptyPriceBook();
  }
}

/** Atomic write (tmp + rename). */
export function writePriceBook(env: { HOME?: string }, book: PriceBook): void {
  const file = priceBookFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(book)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function addCategories(a: CategoryUsage | undefined, b: CategoryUsage | undefined): CategoryUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = zeroCategories();
  for (const category of PRICE_CATEGORIES) sum[category] = a[category] + b[category];
  return sum;
}

/**
 * The transcript's name for a `cost-state` model. The `cost-state` can name
 * a context variant (`claude-opus-5-5[1m]`) that the messages name plainly
 * (`claude-opus-5-5`): without an exact match, the name minus its bracket
 * suffix is used, unless the `cost-state` also lists that plain name.
 */
function transcriptModel(costModel: string, costModels: Record<string, unknown>, byModel: Record<string, unknown>): string | undefined {
  if (costModel in byModel) return costModel;
  const plain = costModel.replace(/\[[^\]]*\]$/, "");
  if (plain === costModel || plain in costModels || !(plain in byModel)) return undefined;
  return plain;
}

/**
 * Learns from one closed session: reads its whole transcript (main and
 * subagent files, at most {@link LEARN_MAX_BYTES}), takes the last
 * `cost-state` (unless it flags an unknown model cost) and, for every model
 * whose transcript tokens match that `cost-state`'s counts (main and
 * subagents together, else the main file alone), records a sample. Returns
 * the models sampled. Never throws; on any problem it learns nothing.
 */
export function learnFromTranscript(path: string, sessionId: string, env: { HOME?: string }, now: number): string[] {
  try {
    const main = readTranscriptSince(path, { bytes: 0 }, { maxBytes: LEARN_MAX_BYTES });
    if (main.truncated || !main.costState || main.costState.hasUnknownModelCost || !main.costModelUsage) return [];

    let remaining = LEARN_MAX_BYTES - main.position.bytes;
    let withSubagents: Record<string, CategoryUsage> | undefined = { ...(main.byModel ?? {}) };
    for (const file of listSubagentTranscripts(path)) {
      const read = readTranscriptSince(file, { bytes: 0 }, { maxBytes: Math.max(0, remaining) });
      if (read.truncated) {
        withSubagents = undefined;
        break;
      }
      remaining -= read.position.bytes;
      for (const [model, tokens] of Object.entries(read.byModel ?? {})) withSubagents[model] = addCategories(withSubagents[model], tokens)!;
    }

    let book = readPriceBook(env);
    const learned: string[] = [];
    const costModels = main.costModelUsage;
    for (const [costModel, counts] of Object.entries(costModels)) {
      const model = transcriptModel(costModel, costModels, withSubagents ?? main.byModel ?? {});
      if (model === undefined) continue;
      const matches = (tokens: CategoryUsage | undefined): tokens is CategoryUsage =>
        tokens !== undefined &&
        tokens.cacheWriteUnsplit === 0 &&
        tokens.input === counts.input &&
        tokens.output === counts.output &&
        tokens.cacheRead === counts.cacheRead &&
        tokens.cacheWrite5m + tokens.cacheWrite1h === counts.cacheWrite;
      const tokens = [withSubagents?.[model], main.byModel?.[model]].find(matches);
      if (!tokens) continue;
      book = recordSample(book, model, { sessionId, at: now, tokens, costUsd: counts.costUsd }, now);
      learned.push(model);
    }
    if (learned.length > 0) writePriceBook(env, book);
    return learned;
  } catch {
    return [];
  }
}
