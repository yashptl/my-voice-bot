-- Who asked: 'visitor', or 'canary' for the hourly check (src/worker/canary.ts). The canary asks
-- through the same path visitors use, so without this its turns would read as visitors' on the
-- review page and the scorecard. Set from the conversation's init (src/worker/conversation.ts).
ALTER TABLE turns ADD COLUMN source TEXT NOT NULL DEFAULT 'visitor';
