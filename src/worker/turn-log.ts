import type { TurnRecord } from "../protocol/turn-record";

/** How long turn rows are kept: the 30-day promise in docs/decisions/0002-data-handling.md. */
export const TURN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Who asked: a visitor, or the hourly canary (migrations/0002_turn_source.sql). */
export type TurnSource = "visitor" | "canary";

/**
 * One row per turn (schema in migrations/, from 0001_init.sql). A record that comes again for the same
 * turn (an interrupt after `turn.end`, while its audio still played) only marks the row interrupted:
 * every other field is the same, and taking the larger value means the two writes can land in
 * either order.
 */
const INSERT = `
INSERT INTO turns (
  turn_id, conversation_id, created_at, mode, model, protocol, prompt_hash, knowledge_hash,
  first_answer_ms, first_sentence_ms, first_audio_ms, done_ms,
  input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd, coverage,
  gate_dropped, gate_reasons, gate_flags, unsupported_count, uncited_count, interrupted, error, source, data_line,
  audio_in_seconds, tts_chars
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)
ON CONFLICT (turn_id) DO UPDATE SET interrupted = MAX(turns.interrupted, excluded.interrupted)`;

/**
 * Writes `r` to the turn log, `at` being when the row is first written. Measurements only: the
 * record holds no visitor or answer text, and the grounding check's claims are stored as counts.
 */
export async function recordTurn(
  db: D1Database,
  r: TurnRecord,
  at: number = Date.now(),
  source: TurnSource = "visitor",
): Promise<void> {
  await db
    .prepare(INSERT)
    .bind(
      r.turnId,
      r.conversationId,
      at,
      r.mode,
      r.model,
      r.protocol,
      r.promptHash,
      r.knowledgeHash,
      r.marks.firstAnswerToken ?? null,
      r.marks.firstSentence ?? null,
      r.marks.firstAudio ?? null,
      r.marks.done ?? null,
      r.tokens.input,
      r.tokens.cachedInput,
      r.tokens.output,
      r.tokens.reasoning,
      r.costUsd,
      r.coverage,
      r.gate.dropped,
      r.gate.reasons.join(","),
      r.gate.flags.join(","),
      r.grounding?.unsupported.length ?? null,
      r.grounding?.uncited.length ?? null,
      r.interrupted ? 1 : 0,
      r.error,
      source,
      r.dataLine,
      r.audioInSeconds,
      r.ttsChars,
    )
    .run();
}

/** Deletes turns written more than TURN_RETENTION_MS before `now`; returns how many went. */
export async function pruneTurns(db: D1Database, now: number): Promise<number> {
  return (await db.prepare("DELETE FROM turns WHERE created_at < ?1").bind(now - TURN_RETENTION_MS).run()).meta.changes;
}
