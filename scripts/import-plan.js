#!/usr/bin/env node
'use strict';
/**
 * import-plan.js — ورودِ دسته‌جمعیِ «برنامه راهبردی» به همان فرمتی که
 * پنل ادمین استفاده می‌کند (strategic.createPhase)، بدون تایپِ دستی.
 *
 * خواندن: plan-import.json در ریشه‌ی پروژه (يا مسیری که با آرگومان بدهید).
 * رفتار:  به‌ازای هر پایه‌ای که در فایل باشد، مراحلِ قبلیِ همان پایه پاک
 *         و مراحلِ جدید جایگزین می‌شوند. پایه‌هایی که در فایل نباشند
 *         دست‌نخورده باقی می‌مانند.
 *
 * استفاده:
 *   node scripts/import-plan.js [مسیر/فایل.json] [--dry-run]
 *
 * قالبِ فایل (هر دو شکلِ تاریخ — شمسی یا میلادی — پذیرفته است):
 * {
 *   "replace": true,
 *   "phases": [
 *     {
 *       "grade": "g11",                       // g10 | g11 | g12
 *       "title": "مرحله اول",
 *       "start": "1405/08/01",                // یا "2026-10-23"
 *       "end":   "1405/08/15",                // یا "2026-11-06"
 *       "topics": ["زیست فصل ۱", "شیمی فصل ۱"],  // یا "زیست فصل ۱ • شیمی فصل ۱"
 *       "examId": 8,                          // اختیاری
 *       "icon": "target",                     // اختیاری
 *       "accent": "#1E7A46"                   // اختیاری
 *     }
 *   ]
 * }
 */
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'data', 'pepsino.sqlite');
if (!fs.existsSync(DB_PATH)) {
  console.error('پایگاه داده پیدا نشد: ' + DB_PATH);
  process.exit(1);
}

const Database = require('better-sqlite3');
const jalali = require('../src/services/jalali');
const strategic = require('../src/services/strategic');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const fileArg = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'plan-import.json';
const DRY = process.argv.includes('--dry-run');
const src = path.resolve(process.cwd(), fileArg);

if (!fs.existsSync(src)) {
  console.error('فایل ورودی پیدا نشد: ' + src);
  console.error('\nنمونه‌ی plan-import.json در scripts/plan-import.example.json است.');
  process.exit(1);
}

/* ----------------------------------------------------- تبدیل تاریخ */
// «1405/08/01» یا «1405-08-01» یا رشته‌ی میلادی/ISO
function toDate(v, field, rowLabel) {
  if (v instanceof Date) return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) throw new Error(`${rowLabel}: ${field} خالی است`);
  // شمسی: 1405/08/01
  let m = /^(\d{4})\s*[-\/]\s*(\d{1,2})\s*[-\/]\s*(\d{1,2})$/.exec(s);
  if (m) {
    const jy = Number(m[1]); const jm = Number(m[2]); const jd = Number(m[3]);
    if (jy < 1300) { // میلادی
      return new Date(`${jy}-${String(jm).padStart(2, '0')}-${String(jd).padStart(2, '0')}T00:00:00.000Z`);
    }
    const g = jalali.j2g(jy, jm, jd);
    return new Date(Date.UTC(g.gy, g.gm - 1, g.gd, 0, 0, 0, 0));
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`${rowLabel}: تاریخ «${s}» قابل فهم نیست`);
  return d;
}

// «زیست فصل ۱ • شیمی فصل ۱» یا «زیست فصل ۱، شیمی فصل ۱» یا آرایه
function toTopics(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(/\s*[•·|،,\n]\s*/).map((x) => x.trim()).filter(Boolean);
}

/* --------------------------------------------------------- اجرا */
let input;
try { input = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) {
  console.error('JSON نامعتبر:', e.message); process.exit(1);
}
const rows = Array.isArray(input) ? input : (input.phases || []);
const doReplace = input.replace !== false;
if (!rows.length) { console.error('هیچ مرحله‌ای در فایل نیست'); process.exit(1); }

// گروه‌بندی بر اساس پایه
const grades = {};
for (const r of rows) {
  const code = String(r.grade || r.gradeCode || 'g10').trim();
  (grades[code] = grades[code] || []).push(r);
}

console.log(`فایل: ${path.basename(src)} — ${rows.length} مرحله برای ${Object.keys(grades).length} پایه`);
console.log(DRY ? '(حالت آزمایشی — چیزی در پایگاه داده تغییر نمی‌کند)\n' : '');

const GRADE_LABEL = { g10: 'پایه دهم', g11: 'پایه یازدهم', g12: 'پایه دوازدهم' };
let created = 0; let removed = 0;

for (const [code, list] of Object.entries(grades)) {
  const grade = db.prepare('SELECT id, code, label FROM grades WHERE code = ?').get(code)
    || db.prepare('SELECT id, code, label FROM grades WHERE code = ?').get('g' + code);
  if (!grade) { console.error(`  ✗ پایه‌ی «${code}» در پایگاه داده نیست — رد شد`); continue; }

  const existing = db.prepare('SELECT COUNT(*) n FROM strategic_phases WHERE grade_id = ?').get(grade.id).n;
  console.log(`— ${GRADE_LABEL[grade.code] || grade.label} (${grade.code}): ${list.length} مرحله`
    + (existing ? ` — جایگزینِ ${existing} مرحله‌ی موجود` : ' — جدید'));

  if (DRY) {
    list.forEach((r, i) => {
      const st = toDate(r.start, 'start', `#${i + 1}`);
      const en = toDate(r.end, 'end', `#${i + 1}`);
      console.log(`    ${i + 1}. ${r.title}  ${st.toISOString().slice(0, 10)} → ${en.toISOString().slice(0, 10)}`
        + (toTopics(r.topics).length ? `  [${toTopics(r.topics).join(' • ')}]` : ''));
    });
    continue;
  }

  try {
    db.transaction(() => {
      if (doReplace) {
        const ids = db.prepare('SELECT id FROM strategic_phases WHERE grade_id = ?').all(grade.id).map((x) => x.id);
        for (const id of ids) strategic.deletePhase(db, id, { actor: 'import' });
        removed += ids.length;
      }
      list.forEach((r, i) => {
        const id = Number.isInteger(r.sortOrder) ? r.sortOrder : i + 1;
        strategic.createPhase(db, {
          title: String(r.title).trim(),
          gradeCode: grade.code,
          startsAt: toDate(r.start, 'start', r.title).toISOString(),
          endsAt: toDate(r.end, 'end', r.title).toISOString(),
          sortOrder: id,
          topicsText: toTopics(r.topics).join(' • ') || null,
          topics: toTopics(r.topics).map((label, k) => ({ label, sortOrder: k })),
          examId: r.examId || null,
        }, { actor: 'import' });
        created += 1;
      });
      // آیکون/رنگِ دلخواه (در createPhase پشتیبانی نمی‌شود)
      for (const r of list) {
        if (!r.icon && !r.accent) continue;
        const row = db.prepare('SELECT id FROM strategic_phases WHERE grade_id = ? AND title = ? ORDER BY id DESC LIMIT 1')
          .get(grade.id, String(r.title).trim());
        if (!row) continue;
        if (r.icon) db.prepare('UPDATE strategic_phases SET icon = ? WHERE id = ?').run(String(r.icon), row.id);
        if (r.accent) db.prepare('UPDATE strategic_phases SET accent = ? WHERE id = ?').run(String(r.accent), row.id);
      }
    })();
    console.log(`    ✓ انجام شد`);
  } catch (e) {
    console.error(`    ✗ خطا: ${e.message}`);
    process.exitCode = 1;
  }
}

if (!DRY) console.log(`\n${'✓'} ${created} مرحله ساخته شد` + (removed ? `، ${removed} مرحله جایگزین شد` : ''));
console.log('\nبرای دیدن نتیجه: پنل ادمین ← برنامه راهبردی (یا صفحه‌ی دانش‌آموز)');
