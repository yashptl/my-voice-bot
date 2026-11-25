import { describe, expect, it } from "vitest";
import { LONG_MESSAGE_CHARS, LONG_MESSAGE_TURNS, MAX_MESSAGE_CHARS, MAX_TRANSCRIPT_CHARS, turnsFor } from "./limits";

describe("limits", () => {
  it("keeps the values the client and the Worker agree on", () => {
    expect([MAX_MESSAGE_CHARS, MAX_TRANSCRIPT_CHARS, LONG_MESSAGE_CHARS, LONG_MESSAGE_TURNS]).toEqual([12_000, 4_000, 4_000, 3]);
  });

  it("counts a message of up to 4,000 characters as one turn and a longer one as three", () => {
    expect(turnsFor("")).toBe(1);
    expect(turnsFor("a".repeat(4000))).toBe(1);
    expect(turnsFor("a".repeat(4001))).toBe(3);
    expect(turnsFor("a".repeat(12_000))).toBe(3);
  });
});
