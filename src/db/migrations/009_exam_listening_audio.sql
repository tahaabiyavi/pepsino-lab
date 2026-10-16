-- 009_exam_listening_audio.sql
-- فایلِ صوتیِ بخشِ لیسنینگِ آزمونِ زبان انگلیسی.
-- هر آزمون حداکثر یک فایلِ صوتی دارد و فقط آزمون‌هایی که درسِ
-- «زبان انگلیسی» را دارند از آن استفاده می‌کنند.
-- Append-only: after this file has been applied, never edit it.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS exam_audio_files (
  id            INTEGER PRIMARY KEY,
  exam_id       INTEGER NOT NULL UNIQUE REFERENCES exams(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  sha256        TEXT NOT NULL,
  storage_name  TEXT NOT NULL UNIQUE,
  uploaded_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exam_audio_exam ON exam_audio_files(exam_id);

-- درسِ زبان انگلیسی (اگر از پیش نباشد)
INSERT INTO subjects (code, label, active)
SELECT 'en', 'زبان انگلیسی', 1
 WHERE NOT EXISTS (SELECT 1 FROM subjects WHERE code = 'en');
