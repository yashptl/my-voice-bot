import { describe, expect, it } from "vitest";
import { cacheHit, prefixTokens } from "./cache";

describe("cacheHit", () => {
  // Readings from the 2026-11-07 MiniMax probe: about 4,000 prompt tokens; a re-query that hit read
  // 3,840 from the cache, and every call, cold or warm, reported a baseline of 128 or 186.
  it("counts a hit only when at least half of the stable prefix came from the cache", () => {
    expect(cacheHit(3840, 4093)).toBe(true);
    expect(cacheHit(2047, 4093)).toBe(true);
    expect(cacheHit(2046, 4093)).toBe(false);
    expect(cacheHit(128, 4093)).toBe(false);
    expect(cacheHit(186, 4093)).toBe(false);
    expect(cacheHit(0, 4093)).toBe(false);
    expect(cacheHit(null, 4093)).toBe(false);
  });

  it("falls back to more than the 128-token baseline when the prefix size is unknown", () => {
    expect(cacheHit(128, null)).toBe(false);
    expect(cacheHit(129, null)).toBe(true);
    expect(cacheHit(null, null)).toBe(false);
  });
});

describe("prefixTokens", () => {
  it("estimates as the knowledge build does: four characters a token, rounded up", () => {
    expect(prefixTokens("x".repeat(16_372))).toBe(4093);
    expect(prefixTokens("abcde")).toBe(2);
  });
});
