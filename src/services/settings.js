'use strict';
/**
 * تنظیماتِ متنیِ سامانه (app_settings)
 * ------------------------------------------------
 * جدول app_settings یک انبارِ ساده‌ی کلید/مقدار است. این ماژول یک لایه‌ی
 * تایپ‌شده روی آن می‌سازد: برای هر کلید یک مقدارِ پیش‌فرض و یک تبدیل
 * (رشته / عدد / بولی) تعریف شده است تا بقیه‌ی کد مجبور نباشد با رشته‌ی خام
 * کار کند و تا زمانی که ادمین چیزی ذخیره نکرده، مقدار پیش‌فرض برگردد.
 *
 * همه‌ی مقادیر توسط ادمین از تب «تنظیمات» قابل ویرایش‌اند.
 */
const { badRequest } = require('./errors');

const SCHEMA = {
  // رتبه‌بندی
  leaderboard_top_n: { type: 'number', def: 5, min: 0, max: 100, group: 'ranking', label: 'تعداد نفرات برترِ قابل نمایش' },
  brand_slogan: { type: 'string', def: 'Get Active to Grow', max: 120, group: 'brand', label: 'شعار برند' },

  // متن‌های صفحه‌ی اصلی پنل دانش‌آموز
  home_head: { type: 'string', def: 'برنامه راهبردی', max: 200, group: 'home', label: 'سطر بالای عنوان اصلی' },
  home_title: { type: 'string', def: 'آزمون‌های مرحله‌ای', max: 200, group: 'home', label: 'عنوان اصلی' },
  home_lead: { type: 'string', def: 'هر مرحله یک آزمون تشریحی از مباحث همان مرحله.', max: 1000, group: 'home', label: 'متن معرفی' },
  home_cta: { type: 'string', def: 'ورود به آزمون این مرحله', max: 200, group: 'home', label: 'متن دکمه‌ی اصلی' },
  plan_title: { type: 'string', def: 'برنامه راهبردی ⬇️', max: 200, group: 'home', label: 'عنوان بخش برنامه' },
  plan_sub: { type: 'string', def: '', max: 500, group: 'home', label: 'زیرعنوان بخش برنامه (خالی = بدون زیرعنوان)' },
  cal_title: { type: 'string', def: 'تقویم آزمون‌ها', max: 200, group: 'home', label: 'عنوان بخش تقویم' },
  cal_sub: { type: 'string', def: '', max: 500, group: 'home', label: 'زیرعنوان بخش تقویم (خالی = بدون زیرعنوان)' },
  exams_title: { type: 'string', def: 'آزمون‌های پیش‌رو', max: 200, group: 'home', label: 'عنوان بخش آزمون‌ها' },
  exams_sub: { type: 'string', def: '', max: 500, group: 'home', label: 'زیرعنوان بخش آزمون‌ها (خالی = بدون زیرعنوان)' },
  board_title: { type: 'string', def: 'رتبه‌بندی', max: 200, group: 'home', label: 'عنوان بخش رتبه‌بندی' },
  board_sub: { type: 'string', def: '', max: 500, group: 'home', label: 'زیرعنوان بخش رتبه‌بندی (خالی = بدون زیرعنوان)' },
  stats_title: { type: 'string', def: 'آمار من', max: 200, group: 'home', label: 'عنوان بخش آمار' },

  // برچسب‌های شمارش معکوس
  countdown_label_before: { type: 'string', def: 'تا شروع آزمون', max: 200, group: 'home', label: 'برچسبِ پیش از شروع' },
  countdown_label_open: { type: 'string', def: 'تا پایان مهلت ارسال', max: 200, group: 'home', label: 'برچسبِ حین آزمون' },
  countdown_label_after: { type: 'string', def: 'مهلت این مرحله تمام شده', max: 200, group: 'home', label: 'برچسبِ پس از پایان' },

  // سربرگِ چاپ
  print_header_line: { type: 'string', def: 'pepsino LAB — Get Active to Grow', max: 300, group: 'print', label: 'سربرگِ برگه‌های چاپی' },

  // پرچم‌های نمایش و رفتار
  show_stats: { type: 'bool', def: true, group: 'home', label: 'نمایش بخش آمار' },
  show_calendar: { type: 'bool', def: true, group: 'home', label: 'نمایش تقویم' },
  show_plan_table: { type: 'bool', def: true, group: 'home', label: 'نمایش نمای جدولی برنامه' },
  allow_practice_after_expiry: { type: 'bool', def: true, group: 'exams', label: 'اجازه‌ی حل تمرینی آزمون‌های منقضی‌شده' },
};

const KEYS = Object.keys(SCHEMA);

function coerce(spec, key, raw) {
  if (raw === undefined || raw === null || raw === '') return spec.def;
  if (spec.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw badRequest('invalid_setting', `مقدار «${key}» باید عدد باشد`);
    const v = Math.min(spec.max === undefined ? Infinity : spec.max, Math.max(spec.min === undefined ? -Infinity : spec.min, n));
    return v;
  }
  if (spec.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    return String(raw) === '1' || String(raw).toLowerCase() === 'true';
  }
  return String(raw).slice(0, spec.max || 5000);
}

/** تمام تنظیمات را با مقدارِ مؤثر (پیش‌فرض اگر ذخیره نشده) برمی‌گرداند. */
function getAll(db) {
  const stored = {};
  for (const r of db.prepare('SELECT key, value FROM app_settings').all()) stored[r.key] = r.value;
  const out = {};
  for (const key of KEYS) out[key] = coerce(SCHEMA[key], key, stored[key]);
  return out;
}

/** یک تنظیم را برمی‌گرداند. */
function get(db, key, fallback) {
  const spec = SCHEMA[key];
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (!spec) return row ? row.value : fallback;
  return row ? coerce(spec, key, row.value) : spec.def;
}

/** مجموعه‌ای از تنظیمات را ذخیره می‌کند (فقط کلیدهای شناخته‌شده). */
function setMany(db, patch, { now = new Date(), actor = 'admin' } = {}) {
  const errors = {};
  const values = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    const spec = SCHEMA[key];
    if (!spec) { errors[key] = 'کلید ناشناخته'; continue; }
    try {
      values[key] = { spec, value: coerce(spec, key, raw) };
    } catch (e) { errors[key] = e.message; }
  }
  if (Object.keys(errors).length) throw badRequest('validation_failed', 'بعضی تنظیمات معتبر نیستند', errors);

  const iso = now.toISOString();
  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    for (const [key, { spec, value }] of Object.entries(values)) {
      const raw = spec.type === 'bool' ? (value ? '1' : '0') : String(value);
      upsert.run(key, raw, iso);
    }
  })();
  return getAll(db);
}

/** برای نمایش در پنل ادمین: کلید + مقدار فعلی + نوع + برچسب + گروه. */
function describe(db) {
  const current = getAll(db);
  return KEYS.map((key) => ({
    key,
    value: current[key],
    type: SCHEMA[key].type,
    group: SCHEMA[key].group,
    label: SCHEMA[key].label,
    min: SCHEMA[key].min,
    max: SCHEMA[key].max,
  }));
}

module.exports = { getAll, get, setMany, describe, SCHEMA, KEYS };
