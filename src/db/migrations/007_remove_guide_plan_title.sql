-- 007_remove_guide_plan_title.sql
-- ۱) حذفِ کاملِ بخش «راهنمای سریع» از پنل دانش‌آموز
-- ۲) تغییرِ عنوانِ بخشِ برنامه‌ی راهبردی و حذفِ زیرعنوانِ آن
-- Append-only: after this file has been applied, never edit it.

PRAGMA foreign_keys = ON;

-- --------------------------------------------------- بخش برنامه‌ی راهبردی
-- عنوان به «برنامه راهبردی ⬇️» تغییر می‌کند.
UPDATE app_settings
   SET value = 'برنامه راهبردی ⬇️', updated_at = datetime('now')
 WHERE key = 'plan_title';

-- زیرعنوانِ این بخش حذف می‌شود (متنِ قبلی دیگر نمایش داده نشود).
UPDATE app_settings
   SET value = '', updated_at = datetime('now')
 WHERE key = 'plan_sub';

-- --------------------------------------------------- حذفِ بخش راهنما
-- بخش «راهنمای سریع» از پنل دانش‌آموز برداشته شد؛ کلیدهایش هم پاک می‌شوند
-- تا در فرمِ تنظیماتِ ادمین به‌عنوان فیلدِ بی‌استفاده دیده نشوند.
DELETE FROM app_settings
 WHERE key IN ('guide_title', 'guide_student', 'guide_notes');
