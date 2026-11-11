/** Latency statistics for probe results. Non-finite values (a mark that never fired) are ignored. */

export type Summary = { n: number; p50: number; p95: number; min: number; max: number };

function finiteSorted(xs: number[]): number[] {
  return xs.filter(Number.isFinite).sort((a, b) => a - b);
}

function nearestRank(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? Number.NaN;
}

/** Nearest-rank percentile: the smallest sample with at least p% of samples at or below it. NaN when empty. */
export function percentile(xs: number[], p: number): number {
  return nearestRank(finiteSorted(xs), p);
}

export function summarize(xs: number[]): Summary {
  const sorted = finiteSorted(xs);
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    min: sorted[0] ?? Number.NaN,
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}
