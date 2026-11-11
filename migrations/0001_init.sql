-- The day's shared ceilings, for all visitors together: one row per unit per UTC day.
-- A spend is one atomic upsert (src/worker/ledger.ts). Rows older than 7 days are pruned hourly.
CREATE TABLE daily (
  day TEXT NOT NULL,      -- UTC date, YYYY-MM-DD
  unit TEXT NOT NULL,     -- what is counted: 'turns'
  used INTEGER NOT NULL,
  PRIMARY KEY (day, unit)
);

-- The turn log: one row per TurnRecord (src/protocol/turn-record.ts), written after the turn ends
-- (src/worker/turn-log.ts). Measurements only, never visitor text or answer text.
-- Rows older than 30 days are pruned hourly (the 30-day promise in docs/decisions/0002).
CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,     -- ms since the epoch, when the row was first written
  mode TEXT NOT NULL,              -- 'text' | 'voice'
  model TEXT NOT NULL,
  protocol INTEGER NOT NULL,
  prompt_hash TEXT NOT NULL,
  knowledge_hash TEXT NOT NULL,
  -- Marks, in ms since the server received the question; NULL when the turn never got there.
  first_answer_ms INTEGER,
  first_sentence_ms INTEGER,
  first_audio_ms INTEGER,
  done_ms INTEGER,
  input_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  cost_usd REAL,                   -- NULL when usage or prices are unknown (the demo)
  coverage TEXT,                   -- 'direct' | 'adjacent' | 'none'; NULL when the data line failed
  gate_dropped INTEGER NOT NULL,   -- sentences the output gate dropped
  gate_reasons TEXT NOT NULL,      -- why, as a comma list ('' when none)
  gate_flags TEXT NOT NULL,        -- what it let through but noted, as a comma list ('' when none)
  unsupported_count INTEGER,       -- grounding check; NULL when the answer did not finish
  uncited_count INTEGER,
  interrupted INTEGER NOT NULL,    -- 0 or 1
  error TEXT
);

CREATE INDEX turns_created_at ON turns (created_at);
CREATE INDEX turns_coverage ON turns (coverage);
