-- Parts the AI is reading right now (for the shared progress message).
-- The bot also creates this table itself if it is missing, so no manual migration is needed.
CREATE TABLE IF NOT EXISTS reading (
  quiz_id INTEGER NOT NULL,
  idx     INTEGER NOT NULL,
  started INTEGER NOT NULL,   -- ms since epoch
  PRIMARY KEY (quiz_id, idx)
);
