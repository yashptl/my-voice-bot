import { describe, expect, it } from "vitest";
import { percentile, summarize } from "./stats";

const oneToTen = [10, 3, 7, 1, 9, 2, 8, 4, 6, 5];

describe("percentile (nearest rank)", () => {
  it("p50 of 1..10 is 5", () => {
    expect(percentile(oneToTen, 50)).toBe(5);
  });

  it("p95 of 1..10 is 10", () => {
    expect(percentile(oneToTen, 95)).toBe(10);
  });

  it("p0 is the minimum and p100 the maximum", () => {
    expect(percentile(oneToTen, 0)).toBe(1);
    expect(percentile(oneToTen, 100)).toBe(10);
  });

  it("is NaN for no samples", () => {
    expect(percentile([], 50)).toBeNaN();
  });

  it("does not reorder the caller's array", () => {
    const xs = [3, 1, 2];
    percentile(xs, 50);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("ignores missing (non-finite) measurements", () => {
    expect(percentile([Number.NaN, 4, Number.POSITIVE_INFINITY, 2], 100)).toBe(4);
  });
});

describe("summarize", () => {
  it("reports NaN statistics for no samples", () => {
    expect(summarize([])).toEqual({ n: 0, p50: Number.NaN, p95: Number.NaN, min: Number.NaN, max: Number.NaN });
  });

  it("summarizes a small sample", () => {
    expect(summarize([3, 1, 2])).toEqual({ n: 3, p50: 2, p95: 3, min: 1, max: 3 });
  });

  it("counts only finite samples in n", () => {
    expect(summarize([Number.NaN, 5]).n).toBe(1);
  });
});
