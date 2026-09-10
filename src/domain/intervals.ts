export interface Interval {
  start: number;
  end: number;
}

/**
 * Restrict every interval to `[windowStart, windowEnd]` and drop any that
 * become empty (or invalid) after clamping.
 */
export function clampIntervals(intervals: Interval[], windowStart: number, windowEnd: number): Interval[] {
  return intervals
    .map((interval) => ({
      start: Math.max(interval.start, windowStart),
      end: Math.min(interval.end, windowEnd),
    }))
    .filter((interval) => interval.end > interval.start);
}

/**
 * Total duration covered by the union of the given intervals — never the
 * sum, so overlapping (e.g. parallel subagent) spans are not double-counted.
 */
export function unionMs(intervals: Array<{ start: number; end: number }>): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);

  let total = 0;
  let currentStart: number | undefined;
  let currentEnd: number | undefined;

  for (const interval of sorted) {
    if (interval.end <= interval.start) continue;

    if (currentStart === undefined || currentEnd === undefined) {
      currentStart = interval.start;
      currentEnd = interval.end;
      continue;
    }

    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
    } else {
      total += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }

  if (currentStart !== undefined && currentEnd !== undefined) {
    total += currentEnd - currentStart;
  }

  return total;
}
