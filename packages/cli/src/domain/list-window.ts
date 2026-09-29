/** A viewport into a flat list: which indices are shown, and how many rows are hidden on each side. */
export interface RowWindow {
  /** First visible index (inclusive). */
  start: number;
  /** One past the last visible index (exclusive). */
  end: number;
  /** Count of rows above `start`. */
  hiddenAbove: number;
  /** Count of rows at/after `end`. */
  hiddenBelow: number;
}

/**
 * The smallest window of at most `maxRows` rows out of `total` that still
 * contains `selected`. When `previousStart` puts `selected` inside the
 * window it already describes, that window is kept as-is (no scrolling on
 * every selection move); otherwise the window scrolls the minimum amount
 * needed to bring `selected` back into view.
 *
 * Pure and stateless: callers persist `previousStart` themselves (e.g. in a
 * `useRef`) and pass it back in on the next call.
 */
export function windowRows(total: number, selected: number, maxRows: number, previousStart = 0): RowWindow {
  const size = Math.max(Math.min(maxRows, total), 0);

  if (size === 0) {
    return { start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }

  if (size >= total) {
    return { start: 0, end: total, hiddenAbove: 0, hiddenBelow: 0 };
  }

  const clampedSelected = Math.min(Math.max(selected, 0), total - 1);
  const maxStart = total - size;

  let start = Math.min(Math.max(previousStart, 0), maxStart);
  if (clampedSelected < start) {
    start = clampedSelected;
  } else if (clampedSelected >= start + size) {
    start = clampedSelected - size + 1;
  }
  start = Math.min(Math.max(start, 0), maxStart);

  const end = start + size;
  return { start, end, hiddenAbove: start, hiddenBelow: total - end };
}
