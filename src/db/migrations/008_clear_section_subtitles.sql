-- 008_clear_section_subtitles.sql
-- حذفِ زیرعنوانِ بخش‌های تقویم، آزمون‌ها و رتبه‌بندی از صفحه‌ی خانه‌ی
-- پنل دانش‌آموز (بنا به درخواست). زیرعنوانِ برنامه هم از قبل خالی بود (۰۰۷).
-- Append-only: after this file has been applied, never edit it.

PRAGMA foreign_keys = ON;

UPDATE app_settings
   SET value = '', updated_at = datetime('now')
 WHERE key IN ('cal_sub', 'exams_sub', 'board_sub');
