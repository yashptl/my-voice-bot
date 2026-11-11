import { describe, expect, it } from "vitest";
import { MAX_INPUT_CHARS, sanitizeInput } from "./sanitize";

const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

describe("sanitizeInput", () => {
  it("strips zero-width, bidi and Unicode tag characters", () => {
    expect(sanitizeInput("a\u200Bb\u202Ec\u{E0041}")).toBe("abc");
  });

  it.each([
    ["U+200B", "\u200B"],
    ["U+200C", "\u200C"],
    ["U+200D", "\u200D"],
    ["U+2060", "\u2060"],
    ["U+FEFF", "\uFEFF"],
    ["U+202A", "\u202A"],
    ["U+202E", "\u202E"],
    ["U+2066", "\u2066"],
    ["U+2069", "\u2069"],
    ["U+E0000", "\u{E0000}"],
    ["U+E007F", "\u{E007F}"],
  ])("strips %s", (_name, ch) => {
    expect(sanitizeInput(`x${ch}y`)).toBe("xy");
  });

  it("keeps ordinary text, newlines, accents and emoji", () => {
    const text = "Hi! Does Yash know React?\nCafé ☕ 👋🏽 1,000 < 2";
    expect(sanitizeInput(text)).toBe(text);
  });

  it("caps input at 4000 characters", () => {
    expect(MAX_INPUT_CHARS).toBe(4000);
    expect(sanitizeInput("a".repeat(5000))).toHaveLength(4000);
  });

  it("strips before capping, so invisible characters do not use up the limit", () => {
    expect(sanitizeInput("\u200B".repeat(100) + "a".repeat(4000))).toBe("a".repeat(4000));
  });

  it("never cuts an emoji in half at the cap", () => {
    const out = sanitizeInput("a" + "😀".repeat(2500));
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).not.toMatch(LONE_HIGH_SURROGATE);
  });
});

describe("sanitizeInput: format characters", () => {
  it("strips a soft hyphen and other Cf characters", () => {
    expect(sanitizeInput("a\u00ADb\u061Cc\u180Ed\u2062e")).toBe("abcde");
  });

  it("NFKC-normalizes, so a fullwidth underscore becomes _", () => {
    expect(sanitizeInput("visitor\uFF3Fmessage")).toBe("visitor_message");
  });
});
