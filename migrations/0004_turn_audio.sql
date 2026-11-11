-- What each voice turn used of the two per-unit services, so the bills can be checked against the
-- log: mic audio sent to Flux (TurnRecord.audioInSeconds; Workers AI bills per audio minute) and
-- characters sent to MiniMax speech (TurnRecord.ttsChars; billed per character). 0 for text turns,
-- NULL on rows written before these columns existed. Written by recordTurn (src/worker/turn-log.ts).
ALTER TABLE turns ADD COLUMN audio_in_seconds REAL;
ALTER TABLE turns ADD COLUMN tts_chars INTEGER;
