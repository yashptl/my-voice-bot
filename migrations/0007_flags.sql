-- Named on/off switches the Worker sets and clears itself. Today there is one row at most:
-- `outage`, present while the model provider will keep failing until someone acts (a rejected
-- key, a used-up plan). Visitors read it where they are admitted (src/worker/ledger.ts admitTurn)
-- and see the resting card; the hourly check clears it once the provider answers again.
-- `reason` is the turn-record error code that set it (llm_auth, llm_quota), never provider or
-- visitor text. `alerted_at` is when the owner's email for this outage went out, so one outage
-- sends one email; null until then.
CREATE TABLE flags (
  name TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  set_at INTEGER NOT NULL,  -- epoch ms
  alerted_at INTEGER        -- epoch ms
);
