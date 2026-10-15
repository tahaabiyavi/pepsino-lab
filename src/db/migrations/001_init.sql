-- 001_init.sql : foundation schema (accounts, registration, sessions,
-- Telegram idempotency, notification outbox, audit log).
-- Migrations are append-only. Never edit an applied migration; add a new one.

PRAGMA foreign_keys = ON;

-- Academic reference data (admin-editable later; no code changes needed).
CREATE TABLE grades (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE academic_fields (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

INSERT INTO grades (code, label, sort_order) VALUES
  ('g10', 'پایه دهم', 10),
  ('g11', 'پایه یازدهم', 11),
  ('g12', 'پایه دوازدهم', 12);

INSERT INTO academic_fields (code, label, sort_order) VALUES
  ('math_physics', 'ریاضی و فیزیک', 1),
  ('experimental', 'علوم تجربی', 2),
  ('humanities', 'علوم انسانی', 3);

-- The single administrator account. The CHECK constraint enforces one row.
CREATE TABLE admin_account (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  username       TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Student accounts. Accounts are created only after approval.
CREATE TABLE students (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  grade_id       INTEGER NOT NULL REFERENCES grades(id),
  field_id       INTEGER NOT NULL REFERENCES academic_fields(id),
  status         TEXT NOT NULL CHECK (status IN ('active','disabled')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  approved_at    TEXT,
  disabled_at    TEXT
);

-- Registration requests. Pending -> accepted | rejected (terminal).
-- The password hash is kept only while the request is pending and is
-- cleared on decision. Plaintext passwords are never stored.
CREATE TABLE registration_requests (
  id              INTEGER PRIMARY KEY,
  username        TEXT NOT NULL COLLATE NOCASE,
  password_hash   TEXT,
  full_name       TEXT NOT NULL,
  grade_id        INTEGER NOT NULL REFERENCES grades(id),
  field_id        INTEGER NOT NULL REFERENCES academic_fields(id),
  status          TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')),
  student_id      INTEGER REFERENCES students(id),
  decided_at      TEXT,
  decided_by      TEXT,           -- 'telegram:<id>' or 'web:admin'
  decision_source TEXT,           -- 'telegram' | 'web'
  created_at      TEXT NOT NULL
);
-- At most one pending request per username.
CREATE UNIQUE INDEX ux_registration_pending_username
  ON registration_requests(username) WHERE status = 'pending';
CREATE INDEX ix_registration_status ON registration_requests(status, created_at);

-- Server-side sessions. Only a SHA-256 of the cookie token is stored.
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('admin','student')),
  subject_id    INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  user_agent    TEXT
);
CREATE INDEX ix_sessions_expires ON sessions(expires_at);

-- Telegram callback log: replay and duplicate protection.
CREATE TABLE telegram_callbacks (
  id                INTEGER PRIMARY KEY,
  callback_query_id TEXT NOT NULL UNIQUE,
  tg_user_id        TEXT NOT NULL,
  action            TEXT NOT NULL,
  target_id         INTEGER,
  outcome           TEXT NOT NULL,
  received_at       TEXT NOT NULL
);

-- Outbox for Telegram/in-app notifications. Business rows never depend on
-- delivery. dedupe_key prevents duplicate notifications on job retries.
CREATE TABLE notification_outbox (
  id              INTEGER PRIMARY KEY,
  dedupe_key      TEXT NOT NULL UNIQUE,
  channel         TEXT NOT NULL CHECK (channel IN ('telegram_admin','telegram_student')),
  recipient       TEXT NOT NULL,
  payload         TEXT NOT NULL,      -- JSON
  status          TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  sent_at         TEXT
);
CREATE INDEX ix_outbox_due ON notification_outbox(status, next_attempt_at);

-- Administrative audit trail. Shared admin credentials mean the actor is
-- recorded as 'admin' (plus Telegram identity where applicable), never as
-- a verified human.
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  created_at   TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  details      TEXT                -- JSON, never contains secrets
);
CREATE INDEX ix_audit_created ON audit_log(created_at);
