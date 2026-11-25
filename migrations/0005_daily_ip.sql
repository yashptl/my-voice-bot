-- Model turns per visitor per UTC day (DAILY_TURNS_PER_IP), text and voice together, so one visitor
-- cannot use up the day for everyone. `ip_hash` is HMAC-SHA256 of `<day>|<client IP>` under the
-- IP_HASH_KEY secret (src/worker/visitor.ts): the table never holds a raw IP, and one day's rows
-- cannot be matched to another's. A spend is one atomic upsert, like `daily`'s (src/worker/ledger.ts).
-- The hourly cron deletes each day's rows once that day is over.
--
-- `daily.unit` (0001) now also counts 'voice_seconds' (mic audio reserved for Flux) and 'tts_chars'
-- (characters reserved for MiniMax speech), beside 'turns'.
CREATE TABLE daily_ip (
  day TEXT NOT NULL,      -- UTC date, YYYY-MM-DD
  ip_hash TEXT NOT NULL,  -- 64 hex characters
  used INTEGER NOT NULL,
  PRIMARY KEY (day, ip_hash)
);
