-- 006_expired_practice_site_content.sql
-- ۱) تبدیل آزمون منقضی‌شده به مجموعه تمرین
-- ۲) متن‌های قابل ویرایش صفحه‌ی اصلی پنل دانش‌آموز
-- ۳) آیکون/رنگ برای مراحل برنامه راهبردی
-- Append-only: after this file has been applied, never edit it.

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------ تمرین از آزمون منقضی
-- مجموعه تمرین می‌تواند از یک آزمون واقعی ساخته شود تا دانش‌آموزانی که
-- مهلت‌شان گذشته، همان سؤالات را به‌صورت تمرینی حل کنند.
ALTER TABLE practice_sets ADD COLUMN source_exam_id INTEGER REFERENCES exams(id) ON DELETE SET NULL;

CREATE TABLE exam_practice_conversions (
  id                 INTEGER PRIMARY KEY,
  exam_id            INTEGER NOT NULL UNIQUE REFERENCES exams(id) ON DELETE CASCADE,
  practice_set_id    INTEGER NOT NULL UNIQUE REFERENCES practice_sets(id) ON DELETE CASCADE,
  question_count     INTEGER NOT NULL CHECK (question_count > 0 AND question_count <= 100),
  answer_key_shared  INTEGER NOT NULL DEFAULT 1 CHECK (answer_key_shared IN (0,1)),
  converted_by       TEXT NOT NULL,
  converted_at       TEXT NOT NULL
);
CREATE INDEX ix_exam_practice_conversions_exam ON exam_practice_conversions(exam_id);

-- ------------------------------------------------------------ ظاهر مراحل
ALTER TABLE strategic_phases ADD COLUMN icon   TEXT;   -- نام آیکون از مجموعه آیکون‌ها
ALTER TABLE strategic_phases ADD COLUMN accent TEXT;   -- رنگِ تأکید (hex)

-- ------------------------------------------------------------ متن‌های صفحه اصلی
-- همه‌ی این کلیدها از پنل ادمین (تب تنظیمات → متن‌های صفحه) قابل ویرایش‌اند.
INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES
  ('home_head',      'برنامه راهبردی', datetime('now')),
  ('home_title',     'آزمون‌های مرحله‌ای', datetime('now')),
  ('home_lead',      'هر مرحله یک آزمون تشریحی از مباحث همان مرحله — برای پایه دهم، یازدهم و دوازدهم. پاسخ‌برگ‌ها توسط مصحح‌ها نمره‌دهی می‌شود و کارنامه پس از تصحیح منتشر می‌شود.', datetime('now')),
  ('home_cta',       'ورود به آزمون این مرحله', datetime('now')),
  ('plan_title',     'برنامه راهبردی', datetime('now')),
  ('plan_sub',       'مراحل مربوط به پایه‌ی خودت را ببین؛ هر مرحله بازه، مباحث و وضعیت خودش را دارد.', datetime('now')),
  ('cal_title',      'تقویم آزمون‌ها', datetime('now')),
  ('cal_sub',        'روزهای آزمون رنگی مشخص شده‌اند؛ روی هر روز بزن تا آزمون همان مرحله باز شود.', datetime('now')),
  ('exams_title',    'آزمون‌های پیش‌رو', datetime('now')),
  ('exams_sub',      'آزمون‌ها تشریحی‌اند. پاسخ‌برگت را بارگذاری کن؛ نمره‌ی هر سؤال بین ۰ تا ۲ است.', datetime('now')),
  ('board_title',    'رتبه‌بندی', datetime('now')),
  ('board_sub',      'برترین‌های هر مرحله — بر اساس نمره‌ی نهایی تصحیح‌شده.', datetime('now')),
  ('guide_title',    'راهنمای سریع', datetime('now')),
  ('guide_student',  'از تب «آزمون‌ها» آزمون بازِ خودت را انتخاب کن، پاسخ‌برگت را بارگذاری کن و «پایان آزمون» را بزن. پس از تصحیح، کارنامه در تب «کارنامه من» منتشر می‌شود.', datetime('now')),
  ('guide_notes',    'هر سؤال حداکثر ۲ نمره دارد و مجموع آزمون ۲۰ نمره است. نمره‌ها با گام ۰/۲۵ ثبت می‌شوند. اگر مهلت ارسال گذشته باشد، می‌توانی همان آزمون را به‌صورت تمرینی حل کنی.', datetime('now')),
  ('stats_title',    'آمار من', datetime('now')),
  ('show_stats',     '1', datetime('now')),
  ('show_calendar',  '1', datetime('now')),
  ('show_plan_table','1', datetime('now')),
  ('allow_practice_after_expiry', '1', datetime('now')),
  ('countdown_label_before', 'تا شروع آزمون', datetime('now')),
  ('countdown_label_open',   'تا پایان مهلت ارسال', datetime('now')),
  ('countdown_label_after',  'مهلت این مرحله تمام شده', datetime('now')),
  ('print_header_line', 'pepsino LAB — Get Active to Grow', datetime('now'));
