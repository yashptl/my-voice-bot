import { describe, expect, it } from "vitest";
import { GREETING, MORE_QUESTIONS, STARTERS } from "./start-screen";

const strings = [GREETING, ...STARTERS.flatMap((s) => [s.text, s.note ?? ""]), ...MORE_QUESTIONS].filter(Boolean);
const questions = [...STARTERS.map((s) => s.text), ...MORE_QUESTIONS];

describe("start-screen copy", () => {
  it("gives every starter a unique id", () => {
    const ids = STARTERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no em or en dashes", () => {
    for (const s of strings) expect(s).not.toMatch(/[–—]/);
  });

  it('never says "he" or "she"', () => {
    for (const s of strings) expect(s).not.toMatch(/\b(he|she)\b/i);
  });

  it("ends every question with a question mark", () => {
    for (const q of questions) expect(q.endsWith("?")).toBe(true);
  });

  it("keeps every string at most 100 characters", () => {
    for (const s of strings) expect(s.length).toBeLessThanOrEqual(100);
  });
});
