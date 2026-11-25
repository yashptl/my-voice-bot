import { describe, expect, it } from "vitest";
import { sqliteD1 } from "../../tests/sqlite-d1";
import { GAP_RETENTION_MS, pruneGaps, recordGap } from "./gap-log";

const AT = Date.UTC(2026, 10, 11, 12);
const GAP = {
  conversationId: "0123456789abcdef-rest",
  mode: "text",
  coverage: "none",
  refs: [] as string[],
  question: "Does Yash know Rust? My email is a@b.co",
} as const;

const rows = (db: ReturnType<typeof sqliteD1>) => db.sqlite.prepare("SELECT * FROM gaps ORDER BY id").all();

describe("recordGap", () => {
  it("writes the time, the first 8 characters of the conversation id, mode, coverage, refs and the question as sent", async () => {
    const db = sqliteD1();
    await recordGap(db, GAP, AT);
    await recordGap(db, { ...GAP, mode: "voice", coverage: "adjacent", refs: ["role:magenta", "skill:ts"], question: "Any Go?" }, AT + 1);
    expect(rows(db)).toEqual([
      { id: 1, created_at: AT, conversation: "01234567", mode: "text", coverage: "none", refs: "[]", question: "Does Yash know Rust? My email is a@b.co" },
      { id: 2, created_at: AT + 1, conversation: "01234567", mode: "voice", coverage: "adjacent", refs: '["role:magenta","skill:ts"]', question: "Any Go?" },
    ]);
  });
});

describe("pruneGaps", () => {
  it("deletes rows older than 30 days and returns how many went", async () => {
    const db = sqliteD1();
    await recordGap(db, GAP, AT - GAP_RETENTION_MS - 1);
    await recordGap(db, GAP, AT - GAP_RETENTION_MS + 1);
    expect(await pruneGaps(db, AT)).toBe(1);
    expect(rows(db)).toHaveLength(1);
  });
});
