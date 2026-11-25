import { describe, expect, it } from "vitest";
import { sqliteD1 } from "../../tests/sqlite-d1";
import type { TurnRecord } from "../protocol/turn-record";
import type { Env } from "./env";
import { recordGap } from "./gap-log";
import { recordTurn } from "./turn-log";
import { weeklySummary } from "./weekly";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** A Monday, 03:17 UTC. */
const MONDAY = Date.UTC(2026, 10, 30, 3, 17);
const TO = "owner@example.test";

type Sent = { to: string; from: string; subject: string; text: string };

const RECORD: TurnRecord = {
  turnId: "t0",
  conversationId: "c1",
  mode: "text",
  protocol: 1,
  model: "fake",
  promptHash: "p",
  knowledgeHash: "k",
  marks: { received: 0 },
  tokens: { input: 0, cachedInput: 0, reasoning: 0, reasoningEstimated: false, output: 0 },
  ttsChars: 0,
  audioInSeconds: 0,
  costUsd: null,
  coverage: null,
  dataLine: null,
  gate: { dropped: 0, reasons: [], flags: [] },
  grounding: null,
  interrupted: false,
  error: null,
};

function setup(o: { mode?: Env["ASSISTANT_MODE"] } = {}) {
  const sent: Sent[] = [];
  const db = sqliteD1();
  const env = {
    DB: db,
    ASSISTANT_MODE: o.mode ?? "voice",
    ALERT_TO: TO,
    ALERT_FROM: "assistant@example.test",
    ALERT_EMAIL: {
      async send(m: Sent) {
        sent.push(m);
        return { messageId: "m1" };
      },
    },
  } as unknown as Env;
  const logs: [string, string][] = [];
  const log = (level: string, line: string) => void logs.push([level, line]);
  return { env, db, sent, logs, log };
}

let n = 0;
const turn = (db: D1Database, at: number, o: Partial<TurnRecord> = {}, source: "visitor" | "canary" = "visitor") =>
  recordTurn(db, { ...RECORD, turnId: `t${++n}`, ...o }, at, source);

describe("weeklySummary", () => {
  it("emails the week's counts, and never visitor text", async () => {
    const h = setup();
    const at = MONDAY - 2 * DAY;
    for (let i = 0; i < 9; i++) await turn(h.db, at);
    await turn(h.db, at, { mode: "voice", audioInSeconds: 30 });
    await turn(h.db, at, { mode: "voice", audioInSeconds: 24 });
    await turn(h.db, at, { mode: "voice", audioInSeconds: 30, error: "llm_failed" });
    // An interrupted answer is not a failed one.
    await turn(h.db, at, { error: "llm_timeout_total", interrupted: true });
    for (let i = 0; i < 3; i++) await turn(h.db, at, {}, "canary");
    await turn(h.db, at, { error: "llm_failed" }, "canary");
    await turn(h.db, at - 10 * DAY, { mode: "voice", audioInSeconds: 600 }); // outside the week
    const gap = { conversationId: "c1", mode: "text", coverage: "none", refs: [], question: "SECRET QUESTION" } as const;
    await recordGap(h.db, gap, at);
    await recordGap(h.db, gap, at);
    await recordGap(h.db, gap, at - 10 * DAY);

    await weeklySummary(h.env, h.log, MONDAY);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ to: TO, from: "assistant@example.test", subject: "Assistant weekly summary" });
    expect(h.sent[0]?.text).toBe(
      [
        "Week to 2026-11-30 (UTC)",
        "Visitor answers: 13 (10 text, 3 voice)",
        "Failed answers: 1",
        "Listening: 1.4 minutes",
        "Questions not fully answered: 2",
        "Hourly checks: 3 answered, 1 failed",
        "",
      ].join("\n"),
    );
    expect(h.sent[0]?.text).not.toContain("SECRET");
  });

  it("sends zeros for an empty week", async () => {
    const h = setup();
    await weeklySummary(h.env, h.log, MONDAY);
    expect(h.sent[0]?.text).toBe(
      [
        "Week to 2026-11-30 (UTC)",
        "Visitor answers: 0 (0 text, 0 voice)",
        "Failed answers: 0",
        "Listening: 0.0 minutes",
        "Questions not fully answered: 0",
        "Hourly checks: 0 answered, 0 failed",
        "",
      ].join("\n"),
    );
  });

  it("sends nothing on any other day of the week", async () => {
    const h = setup();
    for (let d = 1; d < 7; d++) await weeklySummary(h.env, h.log, MONDAY + d * DAY);
    expect(h.sent).toEqual([]);
  });

  it("sends nothing on Monday before 03:00 UTC, and sends from 03:00", async () => {
    const h = setup();
    const midnight = Date.UTC(2026, 10, 30);
    await weeklySummary(h.env, h.log, midnight + 2 * HOUR + 59 * 60_000);
    expect(h.sent).toEqual([]);
    await weeklySummary(h.env, h.log, midnight + 3 * HOUR);
    expect(h.sent).toHaveLength(1);
  });

  it("sends once a day: a second call the same Monday sends nothing, the next Monday sends again", async () => {
    const h = setup();
    await weeklySummary(h.env, h.log, MONDAY);
    await weeklySummary(h.env, h.log, MONDAY + HOUR);
    expect(h.sent).toHaveLength(1);
    await weeklySummary(h.env, h.log, MONDAY + 7 * DAY);
    expect(h.sent).toHaveLength(2);
  });

  it("still sends when the assistant is switched off", async () => {
    const h = setup({ mode: "off" });
    await weeklySummary(h.env, h.log, MONDAY);
    expect(h.sent).toHaveLength(1);
  });

  it("logs an error and sends nothing when the database fails, without throwing", async () => {
    const h = setup();
    (h.env as { DB: unknown }).DB = {
      prepare() {
        throw new Error("D1 unavailable");
      },
    };
    await expect(weeklySummary(h.env, h.log, MONDAY)).resolves.toBeUndefined();
    expect(h.sent).toEqual([]);
    expect(h.logs).toContainEqual(["error", "weekly summary failed: D1 unavailable"]);
  });
});
