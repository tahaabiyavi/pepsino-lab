-- 004_practice_appeals_notifications.sql
-- Practice mode (isolated from official results), score appeals, and
-- in-app student notifications. Append-only: never edit after it is applied.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- practice
-- Practice sets never reference submissions, grading or score history. Their
-- attempts and self-assessed scores live only in the practice_* tables, so they
-- cannot affect rankings, report cards or score history.
CREATE TABLE practice_sets (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  grade_id    INTEGER NOT NULL REFERENCES grades(id),
  subject_id  INTEGER NOT NULL REFERENCES subjects(id),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);

CREATE TABLE practice_questions (
  id                  INTEGER PRIMARY KEY,
  set_id              INTEGER NOT NULL REFERENCES practice_sets(id) ON DELETE CASCADE,
  position            INTEGER NOT NULL CHECK (position > 0),
  body                TEXT NOT NULL,
  max_quarters        INTEGER NOT NULL CHECK (max_quarters > 0 AND max_quarters <= 4000),
  explanatory_answer  TEXT,
  UNIQUE (set_id, position)
);

CREATE TABLE practice_attempts (
  id           INTEGER PRIMARY KEY,
  set_id       INTEGER NOT NULL REFERENCES practice_sets(id),
  student_id   INTEGER NOT NULL REFERENCES students(id),
  started_at   TEXT NOT NULL,
  submitted_at TEXT
);
CREATE INDEX ix_practice_attempts_student ON practice_attempts(student_id, set_id);

-- Self-assessed scores, stored in quarter-points like official marks.
CREATE TABLE practice_scores (
  attempt_id   INTEGER NOT NULL REFERENCES practice_attempts(id) ON DELETE CASCADE,
  question_id  INTEGER NOT NULL REFERENCES practice_questions(id),
  quarters     INTEGER NOT NULL CHECK (quarters >= 0),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (attempt_id, question_id)
);

-- ---------------------------------------------------------------- appeals
-- A student may appeal a finalized official result within a time window after
-- results are published. Only one open appeal per submission.
CREATE TABLE appeals (
  id             INTEGER PRIMARY KEY,
  submission_id  INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  student_id     INTEGER NOT NULL REFERENCES students(id),
  question_id    INTEGER REFERENCES questions(id),
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('open','accepted','rejected')),
  created_at     TEXT NOT NULL,
  decided_at     TEXT,
  decided_by     TEXT,
  decision_note  TEXT
);
CREATE UNIQUE INDEX ux_appeal_open_per_submission ON appeals(submission_id) WHERE status = 'open';
CREATE INDEX ix_appeal_status ON appeals(status, created_at);

-- ---------------------------------------------------------------- notifications
-- In-app notifications for students. dedupe_key makes every event idempotent,
-- so scheduler retries never create duplicates.
CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  read_at     TEXT
);
CREATE INDEX ix_notifications_student ON notifications(student_id, created_at);
