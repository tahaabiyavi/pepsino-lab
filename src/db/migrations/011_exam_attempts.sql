-- زمانِ شروعِ آزمون برای هر دانش‌آموز جداگانه است.
-- مدتِ آزمون از لحظه‌ای که خودِ دانش‌آموز وارد می‌شود حساب می‌شود،
-- نه از زمانِ شروعِ کلیِ آزمون؛ پس هر کس ساعتِ خودش را دارد.

CREATE TABLE IF NOT EXISTS exam_attempts (
  exam_id    INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  PRIMARY KEY (exam_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_exam_attempts_student ON exam_attempts(student_id);
