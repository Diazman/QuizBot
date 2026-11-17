-- Quizzes uploaded by an owner.
CREATE TABLE IF NOT EXISTS quizzes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,          -- public share code used in t.me/<bot>?start=q_<code>
  owner_id      INTEGER NOT NULL,              -- Telegram user id of the creator
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | processing | ready | failed
  raw_text      TEXT NOT NULL DEFAULT '',      -- text collected while in draft
  chunks_total  INTEGER NOT NULL DEFAULT 0,
  chunks_done   INTEGER NOT NULL DEFAULT 0,
  chunks_failed INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quizzes_owner ON quizzes(owner_id);

-- Pieces of raw text waiting for the AI.
CREATE TABLE IF NOT EXISTS chunks (
  quiz_id  INTEGER NOT NULL,
  idx      INTEGER NOT NULL,
  text     TEXT NOT NULL,
  status   TEXT NOT NULL DEFAULT 'pending',    -- pending | done | failed
  error    TEXT,
  PRIMARY KEY (quiz_id, idx)
);

-- Normalised questions (the "bot format").
CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id     INTEGER NOT NULL,
  position    INTEGER NOT NULL,
  question    TEXT NOT NULL,
  options     TEXT NOT NULL,                   -- JSON array of strings
  correct     INTEGER NOT NULL,                -- 0-based index into options
  explanation TEXT,
  confidence  TEXT                             -- high | medium | low (AI self-assessment)
);
CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id, position);

-- One active practice run per user.
CREATE TABLE IF NOT EXISTS sessions (
  user_id   INTEGER PRIMARY KEY,
  chat_id   INTEGER NOT NULL,
  quiz_id   INTEGER NOT NULL,
  q_order   TEXT NOT NULL,                     -- JSON array of question ids
  idx       INTEGER NOT NULL DEFAULT 0,
  score     INTEGER NOT NULL DEFAULT 0,
  poll_id   TEXT,
  started_at INTEGER NOT NULL
);

-- Which user is currently editing which draft.
CREATE TABLE IF NOT EXISTS drafts (
  user_id INTEGER PRIMARY KEY,
  quiz_id INTEGER NOT NULL
);
