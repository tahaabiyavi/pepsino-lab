-- 005_strategic_plan_and_exam_files.sql
-- برنامه راهبردی (قابل ویرایش از پنل ادمین) + فایل واحد سؤالات آزمون
-- و تنظیمات لیدربورد + فیلدهای پشتیبانی از نمره ۰ تا ۲ با گام ۰.۲۵

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- برنامه راهبردی
-- هر «مرحله» یک آزمون برنامه‌ریزی‌شده است (مثلاً آزمون مرحله اول).
-- ادمین می‌تواند CRUD کامل انجام دهد. فقط مراحل مربوط به پایه دانش‌آموز نمایش داده می‌شود.
CREATE TABLE strategic_phases (
  id              INTEGER PRIMARY KEY,
  title           TEXT NOT NULL,                 -- مثلاً «آزمون مرحله اول»
  grade_id        INTEGER NOT NULL REFERENCES grades(id),
  starts_at       TEXT NOT NULL,                 -- شروع بازه
  ends_at         TEXT NOT NULL,                 -- پایان بازه
  sort_order      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  exam_id         INTEGER REFERENCES exams(id) ON DELETE SET NULL, -- لینک اختیاری به آزمون واقعی
  topics_text     TEXT,                          -- مباحث (متن آزاد یا JSON)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (starts_at < ends_at)
);
CREATE INDEX ix_strategic_phases_grade ON strategic_phases(grade_id, sort_order);

-- مباحث هر مرحله (اختیاری؛ اگر topics_text کافی نباشد)
CREATE TABLE strategic_phase_topics (
  id          INTEGER PRIMARY KEY,
  phase_id    INTEGER NOT NULL REFERENCES strategic_phases(id) ON DELETE CASCADE,
  subject_id  INTEGER REFERENCES subjects(id),
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- فایل واحد سؤالات آزمون
-- به جای آپلود دانه‌دانه سؤال، یک فایل PDF/عکس برای کل سؤالات آپلود می‌شود.
CREATE TABLE exam_question_files (
  id            INTEGER PRIMARY KEY,
  exam_id       INTEGER NOT NULL UNIQUE REFERENCES exams(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256        TEXT NOT NULL,
  storage_name  TEXT NOT NULL UNIQUE,
  uploaded_at   TEXT NOT NULL
);

-- تعداد سؤالات برای تصحیح (مصحح به ازای هر سؤال ۰ تا ۲ می‌دهد)
-- اگر null باشد، از تعداد رکوردهای questions استفاده می‌شود.
ALTER TABLE exams ADD COLUMN question_count INTEGER CHECK (question_count IS NULL OR (question_count > 0 AND question_count <= 100));

-- ---------------------------------------------------------------- تنظیمات لیدربورد
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
INSERT INTO app_settings (key, value, updated_at) VALUES
  ('leaderboard_top_n', '5', datetime('now')),
  ('brand_slogan', 'Get Active to Grow', datetime('now'));

-- ---------------------------------------------------------------- پشتیبانی از غیبت خودکار
-- status در submissions قبلاً 'submitted' دارد؛ 'absent' را هم پشتیبانی می‌کنیم.
-- (در migration قبلی CHECK محدود بود؛ اینجا جدول را بازتعریف نمی‌کنیم چون SQLite محدودیت دارد،
--  اما در منطق اپلیکیشن از status='absent' استفاده می‌شود.)
