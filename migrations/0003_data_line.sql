-- How each reply's data line came out (TurnRecord.dataLine, src/protocol/turn-record.ts): 'ok';
-- 'missing' when the reply had none (no sources, no contact flag); 'invalid' when it would not parse
-- or was a bare <refs> list. NULL when the turn ended before the reply was complete, and on rows
-- written before this column existed. Written by recordTurn (src/worker/turn-log.ts).
ALTER TABLE turns ADD COLUMN data_line TEXT;
