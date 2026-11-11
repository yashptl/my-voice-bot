import { describe, expect, it } from "vitest";
import { sqliteD1 } from "../../tests/sqlite-d1";
import type { TurnRecord } from "../protocol/turn-record";
import { pruneTurns, recordTurn, TURN_RETENTION_MS } from "./turn-log";

const AT = Date.UTC(2026, 10, 8, 12);
const DAY = 24 * 60 * 60 * 1000;

const TEXT: TurnRecord = {
  turnId: "turn-text",
  conversationId: "conv-1",
  mode: "text",
  protocol: 1,
  model: "MiniMax-M3.1-Flash",
  promptHash: "p".repeat(64),
  knowledgeHash: "k".repeat(64),
  marks: { received: 0, firstReasoning: 300, firstAnswerToken: 640, firstSentence: 910, done: 2200 },
  tokens: { input: 21000, cachedInput: 20480, reasoning: 120, reasoningEstimated: true, output: 180 },
  ttsChars: 0,
  audioInSeconds: 0,
  costUsd: 0.00041,
  coverage: "direct",
  dataLine: "ok",
  gate: { dropped: 1, reasons: ["url", "email"], flags: ["markdown", "hype"] },
  grounding: { checked: 4, unsupported: ["Google"], uncited: ["Amazon", "Toronto"] },
  interrupted: false,
  error: null,
};

const VOICE: TurnRecord = {
  ...TEXT,
  turnId: "turn-voice",
  mode: "voice",
  marks: { received: 0, endOfTurn: 0, firstAnswerToken: 500, firstSentence: 700, firstAudio: 950 },
  tokens: { input: 21000, cachedInput: 0, reasoning: 0, reasoningEstimated: false, output: 40 },
  ttsChars: 120,
  audioInSeconds: 3.2,
  droppedFrames: 0,
  costUsd: null,
  coverage: null,
  dataLine: null,
  gate: { dropped: 0, reasons: [], flags: [] },
  grounding: null,
  interrupted: true,
  error: "tts_timeout",
};

/** The same voice turn as it ended on its own, before any late interrupt. */
const VOICE_ENDED: TurnRecord = { ...VOICE, interrupted: false, error: null };

const rowsOf = (db: ReturnType<typeof sqliteD1>) => db.sqlite.prepare("SELECT * FROM turns ORDER BY created_at").all();

describe("recordTurn", () => {
  it("writes a text record as one row of measurements", async () => {
    const db = sqliteD1();
    await recordTurn(db, TEXT, AT);
    expect(rowsOf(db)).toEqual([
      {
        turn_id: "turn-text",
        conversation_id: "conv-1",
        created_at: AT,
        mode: "text",
        model: "MiniMax-M3.1-Flash",
        protocol: 1,
        prompt_hash: "p".repeat(64),
        knowledge_hash: "k".repeat(64),
        first_answer_ms: 640,
        first_sentence_ms: 910,
        first_audio_ms: null,
        done_ms: 2200,
        input_tokens: 21000,
        cached_tokens: 20480,
        output_tokens: 180,
        reasoning_tokens: 120,
        cost_usd: 0.00041,
        coverage: "direct",
        gate_dropped: 1,
        gate_reasons: "url,email",
        gate_flags: "markdown,hype",
        unsupported_count: 1,
        uncited_count: 2,
        interrupted: 0,
        error: null,
        source: "visitor",
        data_line: "ok",
        audio_in_seconds: 0,
        tts_chars: 0,
      },
    ]);
  });

  it("stores a voice turn's mic seconds and spoken characters, which Flux and MiniMax bill by", async () => {
    const db = sqliteD1();
    await recordTurn(db, VOICE, AT);
    expect(rowsOf(db).map((r) => [r.mode, r.audio_in_seconds, r.tts_chars])).toEqual([["voice", 3.2, 120]]);
  });

  it("stores how the data line came out, so failed ones can be counted", async () => {
    const db = sqliteD1();
    await recordTurn(db, { ...TEXT, turnId: "missing", dataLine: "missing", coverage: null }, AT);
    await recordTurn(db, { ...TEXT, turnId: "invalid", dataLine: "invalid", coverage: null }, AT + 1);
    expect(rowsOf(db).map((r) => [r.turn_id, r.data_line, r.coverage])).toEqual([
      ["missing", "missing", null],
      ["invalid", "invalid", null],
    ]);
  });

  it("tags the canary's turns, so the review page and scorecard can leave them out", async () => {
    const db = sqliteD1();
    await recordTurn(db, TEXT, AT, "canary");
    await recordTurn(db, { ...TEXT, turnId: "turn-visitor" }, AT + 1);
    expect(rowsOf(db).map((r) => [r.turn_id, r.source])).toEqual([
      ["turn-text", "canary"],
      ["turn-visitor", "visitor"],
    ]);
  });

  it("writes a voice record, with NULLs for what the turn never reached", async () => {
    const db = sqliteD1();
    await recordTurn(db, VOICE, AT);
    expect(rowsOf(db)[0]).toMatchObject({
      turn_id: "turn-voice",
      mode: "voice",
      first_answer_ms: 500,
      first_sentence_ms: 700,
      first_audio_ms: 950,
      done_ms: null,
      cached_tokens: 0,
      cost_usd: null,
      coverage: null,
      gate_dropped: 0,
      gate_reasons: "",
      gate_flags: "",
      unsupported_count: null,
      uncited_count: null,
      interrupted: 1,
      error: "tts_timeout",
      data_line: null,
    });
  });

  it("never stores the claims the grounding check found, only their counts", async () => {
    const db = sqliteD1();
    await recordTurn(db, TEXT, AT);
    const stored = JSON.stringify(rowsOf(db));
    for (const claim of ["Google", "Amazon", "Toronto"]) expect(stored).not.toContain(claim);
  });

  it("marks a turn interrupted when its record comes again after a late interrupt, keeping when it was written", async () => {
    const db = sqliteD1();
    await recordTurn(db, VOICE_ENDED, AT);
    await recordTurn(db, { ...VOICE_ENDED, interrupted: true }, AT + 5000);
    expect(rowsOf(db)).toEqual([expect.objectContaining({ turn_id: "turn-voice", created_at: AT, interrupted: 1 })]);
  });

  it("keeps a late interrupt even when its write lands before the turn's own", async () => {
    const db = sqliteD1();
    await recordTurn(db, { ...VOICE_ENDED, interrupted: true }, AT + 5000);
    await recordTurn(db, VOICE_ENDED, AT);
    expect(rowsOf(db)).toEqual([expect.objectContaining({ turn_id: "turn-voice", interrupted: 1 })]);
  });
});

describe("pruneTurns", () => {
  it("deletes turns written more than 30 days ago and keeps the rest", async () => {
    expect(TURN_RETENTION_MS).toBe(30 * DAY);
    const db = sqliteD1();
    await recordTurn(db, { ...TEXT, turnId: "old" }, AT - 30 * DAY - 1);
    await recordTurn(db, { ...TEXT, turnId: "edge" }, AT - 30 * DAY);
    await recordTurn(db, { ...TEXT, turnId: "new" }, AT - DAY);
    expect(await pruneTurns(db, AT)).toBe(1);
    expect(rowsOf(db).map((r) => r.turn_id)).toEqual(["edge", "new"]);
  });
});
