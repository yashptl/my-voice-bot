-- The gap log: questions the knowledge only partly covered (coverage 'adjacent' or 'none'), kept so
-- Yash can write new knowledge. Unlike `turns`, this table DOES hold visitor text: the question as
-- sent (text) or as transcribed (voice), unredacted, by the owner's decision of 2026-11-11 (see
-- docs/decisions/0002-data-handling.md). Never the answer. Written off the visitor's path after the
-- reply's data line parsed (src/worker/gap-log.ts); not written for the hourly canary.
-- Rows older than 30 days are pruned hourly. Read with `npm run gaps`.
CREATE TABLE gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,     -- ms since the epoch
  conversation TEXT NOT NULL,      -- the first 8 characters of the conversation id
  mode TEXT NOT NULL,              -- 'text' | 'voice'
  coverage TEXT NOT NULL,          -- 'adjacent' | 'none'
  refs TEXT NOT NULL,              -- the refs the reply cited, as a JSON array
  question TEXT NOT NULL
);

CREATE INDEX gaps_created_at ON gaps (created_at);
