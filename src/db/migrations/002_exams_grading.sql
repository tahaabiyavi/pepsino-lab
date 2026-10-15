-- 002_exams_grading.sql : academic structure, examinations, questions,
-- submissions, grader profiles, assignments, question scores, score history.
-- Append-only: never edit this file after it has been applied.

PRAGMA foreign_keys = ON;

CREATE TABLE academic_years (
  id          INTEGER PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,
  starts_on   TEXT NOT NULL,
  ends_on     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE subjects (
  id      INTEGER PRIMARY KEY,
  code    TEXT NOT NULL UNIQUE,
  label   TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE topics (
  id          INTEGER PRIMARY KEY,
  subject_id  INTEGER NOT NULL REFERENCES subjects(id),
  label       TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (subject_id, label)
);

-- Examinations. Times are stored as UTC ISO-8601 strings and displayed in the
-- configured application timezone. The server is the authority on time.
CREATE TABLE exams (
  id                      INTEGER PRIMARY KEY,
  title                   TEXT NOT NULL,
  academic_year_id        INTEGER NOT NULL REFERENCES academic_years(id),
  status                  TEXT NOT NULL CHECK (status IN (
                            'draft','published','in_progress','submission_closed',
                            'grading','results_published','archived')),
  instructions            TEXT,
  starts_at               TEXT NOT NULL,
  duration_minutes        INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 300),
  submission_deadline     TEXT NOT NULL,
  answer_key_publish_at   TEXT NOT NULL,
  results_publish_at      TEXT NOT NULL,
  answer_key_published_at TEXT,
  results_published_at    TEXT,
  total_quarters          INTEGER NOT NULL DEFAULT 0 CHECK (total_quarters >= 0),
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  CHECK (starts_at < submission_deadline),
  CHECK (submission_deadline <= answer_key_publish_at),
  CHECK (answer_key_publish_at <= results_publish_at)
);
CREATE INDEX ix_exams_status ON exams(status);

CREATE TABLE exam_grades (
  exam_id  INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  grade_id INTEGER NOT NULL REFERENCES grades(id),
  PRIMARY KEY (exam_id, grade_id)
);
CREATE TABLE exam_fields (
  exam_id  INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES academic_fields(id),
  PRIMARY KEY (exam_id, field_id)
);
CREATE TABLE exam_subjects (
  exam_id    INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  PRIMARY KEY (exam_id, subject_id)
);

-- Questions are individual records. max_quarters is the maximum mark in quarters.
CREATE TABLE questions (
  id                    INTEGER PRIMARY KEY,
  exam_id               INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  position              INTEGER NOT NULL CHECK (position > 0),
  subject_id            INTEGER NOT NULL REFERENCES subjects(id),
  body                  TEXT NOT NULL,
  max_quarters          INTEGER NOT NULL CHECK (max_quarters > 0 AND max_quarters <= 4000),
  grading_instructions  TEXT,
  explanatory_answer    TEXT,
  UNIQUE (exam_id, position)
);
CREATE TABLE question_topics (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  topic_id    INTEGER NOT NULL REFERENCES topics(id),
  PRIMARY KEY (question_id, topic_id)
);

-- Answer-key document metadata. Files are stored privately under generated names.
CREATE TABLE answer_keys (
  id            INTEGER PRIMARY KEY,
  exam_id       INTEGER NOT NULL UNIQUE REFERENCES exams(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256        TEXT NOT NULL,
  storage_name  TEXT NOT NULL UNIQUE,
  uploaded_at   TEXT NOT NULL
);

-- One row per (exam, student). 'missing' = deadline passed without upload (score 0).
-- 'absent' = administratively classified absent (excluded from rankings).
CREATE TABLE submissions (
  id            INTEGER PRIMARY KEY,
  exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES students(id),
  status        TEXT NOT NULL CHECK (status IN ('submitted','missing','absent')),
  submitted_at  TEXT,
  finalized_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (exam_id, student_id)
);
CREATE INDEX ix_submissions_exam ON submissions(exam_id, status);

-- Internal grading identities (not admin accounts).
CREATE TABLE grader_profiles (
  id            INTEGER PRIMARY KEY,
  display_name  TEXT NOT NULL,
  icon          TEXT NOT NULL DEFAULT '🧑‍🏫',
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL,
  last_active_at TEXT
);

CREATE TABLE grading_batches (
  id          INTEGER PRIMARY KEY,
  exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('initial','reassignment','manual')),
  created_at  TEXT NOT NULL,
  note        TEXT
);

-- state: active (in progress) | completed (finalized) | reassigned (history only).
-- A submission has at most one active-or-completed assignment at any time.
CREATE TABLE grading_assignments (
  id              INTEGER PRIMARY KEY,
  submission_id   INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  grader_id       INTEGER NOT NULL REFERENCES grader_profiles(id),
  batch_id        INTEGER NOT NULL REFERENCES grading_batches(id),
  state           TEXT NOT NULL CHECK (state IN ('active','completed','reassigned')),
  overall_comment TEXT,
  assigned_at     TEXT NOT NULL,
  completed_at    TEXT,
  reassigned_at   TEXT,
  reassign_reason TEXT
);
CREATE UNIQUE INDEX ux_assignment_open ON grading_assignments(submission_id)
  WHERE state IN ('active','completed');
CREATE INDEX ix_assignment_grader ON grading_assignments(grader_id, state);

CREATE TABLE question_scores (
  id              INTEGER PRIMARY KEY,
  assignment_id   INTEGER NOT NULL REFERENCES grading_assignments(id) ON DELETE CASCADE,
  question_id     INTEGER NOT NULL REFERENCES questions(id),
  quarters        INTEGER NOT NULL CHECK (quarters >= 0),
  comment         TEXT,
  updated_at      TEXT NOT NULL,
  UNIQUE (assignment_id, question_id)
);

-- Every correction keeps the previous value, the new value and the reason.
CREATE TABLE score_history (
  id                 INTEGER PRIMARY KEY,
  submission_id      INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id        INTEGER REFERENCES questions(id),
  previous_quarters  INTEGER,
  new_quarters       INTEGER NOT NULL,
  reason             TEXT,
  actor              TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE TABLE exam_change_log (
  id          INTEGER PRIMARY KEY,
  exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL,
  details     TEXT,
  actor       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
