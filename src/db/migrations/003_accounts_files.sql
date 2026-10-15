-- 003_accounts_files.sql
-- Grader login accounts (separate from the single super-admin account),
-- password reset tokens, pending/final submission files.
-- Append-only: never edit this file after it has been applied.

PRAGMA foreign_keys = ON;

-- Grader accounts: each grader signs in with their own username and password.
-- They are still NOT administrator accounts and have no admin privileges.
ALTER TABLE grader_profiles ADD COLUMN username TEXT;
ALTER TABLE grader_profiles ADD COLUMN password_hash TEXT;
CREATE UNIQUE INDEX ux_grader_username ON grader_profiles(username) WHERE username IS NOT NULL;

-- Sessions must also be able to represent grader subjects. SQLite cannot alter
-- a CHECK constraint in place, so the table is rebuilt and the data copied.
CREATE TABLE sessions_new (
  token_hash    TEXT PRIMARY KEY,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('admin','student','grader')),
  subject_id    INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  user_agent    TEXT
);
INSERT INTO sessions_new (token_hash, subject_type, subject_id, created_at, last_seen_at, expires_at, user_agent)
  SELECT token_hash, subject_type, subject_id, created_at, last_seen_at, expires_at, user_agent FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX ix_sessions_expires ON sessions(expires_at);

-- One-time password reset tokens. Only a hash is stored. The token is shown once
-- to the administrator, who passes it to the account owner out of band.
CREATE TABLE password_resets (
  id            INTEGER PRIMARY KEY,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('student','grader')),
  subject_id    INTEGER NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT
);
CREATE INDEX ix_password_resets_subject ON password_resets(subject_type, subject_id);

-- Uploaded files that are not yet part of a finalized submission.
-- Finalizing moves them into submission_files in one transaction.
CREATE TABLE pending_uploads (
  id            INTEGER PRIMARY KEY,
  exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES students(id),
  storage_name  TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX ix_pending_student_exam ON pending_uploads(student_id, exam_id);

-- Finalized answer-sheet files. Each one belongs to exactly one submission.
CREATE TABLE submission_files (
  id                INTEGER PRIMARY KEY,
  submission_id     INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  storage_name      TEXT NOT NULL UNIQUE,
  original_name     TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256            TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'valid' CHECK (validation_status IN ('valid')),
  uploaded_at       TEXT NOT NULL
);
CREATE INDEX ix_submission_files_sub ON submission_files(submission_id);
