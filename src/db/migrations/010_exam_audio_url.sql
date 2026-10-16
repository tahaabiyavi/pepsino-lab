-- فایل صوتیِ لیسنینگ می‌تواند به‌جای بارگذاری روی سرور، فقط یک پیوندِ خارجی باشد.
-- (بارگذاریِ مستقیم روی some سرورها به علت محدودیتِ حجم/پروکسی پشت سر راه انجام نمی‌شود.)

CREATE TABLE exam_audio_files_new (
  exam_id       INTEGER NOT NULL UNIQUE REFERENCES exams(id) ON DELETE CASCADE,
  -- ستون‌های فایلِ بارگذاری‌شده (در حالتِ پیوند، تهی می‌مانند)
  original_name TEXT,
  mime_type     TEXT,
  size_bytes    INTEGER CHECK (size_bytes IS NULL OR size_bytes <= 20971520),
  sha256        TEXT,
  storage_name  TEXT UNIQUE,
  -- پیوندِ مستقیم یا صفحه‌ی یک سرویسِ میزبان (مثل یوتیوب/آپارات/ساندکلود)
  audio_url     TEXT,
  uploaded_at   TEXT NOT NULL
);

INSERT INTO exam_audio_files_new
  (exam_id, original_name, mime_type, size_bytes, sha256, storage_name, uploaded_at)
  SELECT exam_id, original_name, mime_type, size_bytes, sha256, storage_name, uploaded_at
  FROM exam_audio_files;

DROP TABLE exam_audio_files;
ALTER TABLE exam_audio_files_new RENAME TO exam_audio_files;
CREATE INDEX idx_exam_audio_exam ON exam_audio_files(exam_id);
