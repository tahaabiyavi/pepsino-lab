'use strict';
/**
 * داده‌ی نمایشی برای دیدنِ پنل‌ها در مرورگر (فقط محیط توسعه).
 * یک مدیر، چند دانش‌آموز، درس‌ها، سه مرحله‌ی برنامه راهبردی و سه آزمون
 * (یکی در حال برگزاری، یکی آینده، یکی منقضی‌شده) می‌سازد.
 *
 *   node scripts/seed-demo.js
 */
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pepsino.sqlite');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

require('../src/db/migrate').migrate(db, { info: (m) => console.log(m) });

const { hashPassword } = require('../src/auth/passwords');
const now = new Date();
const iso = (ms) => new Date(now.getTime() + ms).toISOString();
const HOUR = 3600e3;

console.log('— ساخت داده‌ی نمایشی…');

// ------------------------------------------------------------------ پایه/رشته/درس
const grades = ['g10', 'g11', 'g12'];
const gradeIds = {};
for (const [i, code] of grades.entries()) {
  const label = ['پایه دهم', 'پایه یازدهم', 'پایه دوازدهم'][i];
  db.prepare('INSERT INTO grades (code, label, sort_order, active) VALUES (?,?,?,1) ON CONFLICT(code) DO NOTHING')
    .run(code, label, i + 1);
  gradeIds[code] = db.prepare('SELECT id FROM grades WHERE code = ?').get(code).id;
}
const fields = [['math_physics', 'ریاضی-فیزیک'], ['bio', 'تجربی'], ['humanities', 'انسانی']];
for (const [code, label] of fields) {
  db.prepare('INSERT INTO academic_fields (code, label, active) VALUES (?,?,1) ON CONFLICT(code) DO NOTHING').run(code, label);
}
const subjects = [['bio', 'زیست‌شناسی'], ['chem', 'شیمی'], ['phys', 'فیزیک'], ['math', 'ریاضی']];
const subjectIds = {};
for (const [code, label] of subjects) {
  db.prepare('INSERT INTO subjects (code, label, active) VALUES (?,?,1) ON CONFLICT(code) DO NOTHING').run(code, label);
  subjectIds[code] = db.prepare('SELECT id FROM subjects WHERE code = ?').get(code).id;
}
// مباحث هر درس
const topicIds = {};
for (const code of Object.keys(subjectIds)) {
  db.prepare('INSERT INTO topics (subject_id, label, active) VALUES (?,?,1) ON CONFLICT DO NOTHING')
    .run(subjectIds[code], `فصل ۱ — ${code}`);
  topicIds[code] = db.prepare('SELECT id FROM topics WHERE subject_id = ? LIMIT 1').get(subjectIds[code]).id;
}

db.prepare(`INSERT INTO academic_years (label, starts_on, ends_on, created_at)
            SELECT '1405-1406','2026-09-23','2027-06-20',?
            WHERE NOT EXISTS (SELECT 1 FROM academic_years WHERE label='1405-1406')`).run(iso(0));
const yearId = db.prepare("SELECT id FROM academic_years WHERE label='1405-1406'").get().id;

// ------------------------------------------------------------------ مدیر
const admins = db.prepare('SELECT COUNT(*) n FROM admin_account').get().n;
if (admins === 0) {
  db.prepare('INSERT INTO admin_account (id, username, password_hash, updated_at) VALUES (1,?,?,?)')
    .run('admin', hashPassword('AdminPass123', 10), iso(0));
  console.log('  مدیر: admin / AdminPass123');
}

// ------------------------------------------------------------------ دانش‌آموزان
const NAMES = ['علی رضایی', 'سارا احمدی', 'محمد حسینی', 'فاطمه کریمی', 'حسن موسوی', 'زهرا جعفری'];
const studentIds = [];
for (const [i, name] of NAMES.entries()) {
  const username = 'stu' + (i + 1);
  const exists = db.prepare('SELECT id FROM students WHERE username = ?').get(username);
  if (exists) { studentIds.push(exists.id); continue; }
  const r = db.prepare(`INSERT INTO students (username,password_hash,full_name,grade_id,field_id,status,created_at,updated_at,approved_at)
                        VALUES (?,?,?,?,?,'active',?,?,?)`)
    .run(username, hashPassword('StudentPass1', 10), name, gradeIds.g10,
      db.prepare("SELECT id FROM academic_fields WHERE code='math_physics'").get().id, iso(0), iso(0), iso(0));
  studentIds.push(Number(r.lastInsertRowid));
}
console.log(`  ${studentIds.length} دانش‌آموز (stu1…stu6 / StudentPass1)`);

// ------------------------------------------------------------------ آزمون‌ها + پاسخنامه
const examsSvc = require('../src/services/exams');
const storage = require('../src/files/storage');

/** یک PDFِ بسیار کوچکِ معتبر برای پاسخنامه. */
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');

function makeExam({ title, startsAt, deadline, status = 'published' }) {
  // زمان‌بندی باید معتبر باشد: شروع < مهلت ≤ پاسخنامه ≤ نتایج
  const end = new Date(deadline).getTime();
  const ex = examsSvc.createExam(db, {
    title,
    academicYearId: yearId,
    gradeCodes: ['g10'],
    startsAt, submissionDeadline: deadline,
    answerKeyPublishAt: new Date(end + 2 * HOUR).toISOString(),
    resultsPublishAt: new Date(end + 4 * HOUR).toISOString(),
    durationMinutes: 90,
  }, { now: new Date(Date.now() - 10 * HOUR) });

  // سؤالات تشریحی: ۱۰ سؤال، هرکدام ۲ نمره
  for (let i = 1; i <= 10; i++) {
    const sub = ['bio', 'chem', 'phys', 'math'][i % 4];
    examsSvc.addQuestion(db, ex.id, {
      body: `سؤال ${i} — مبحث ${['زیست', 'شیمی', 'فیزیک', 'ریاضی'][i % 4]}`,
      maxMark: '2',
      subjectId: subjectIds[sub],
      topicIds: [topicIds[sub]],
    }, { now: new Date(Date.now() - 10 * HOUR) });
  }

  // پاسخنامه روی دیسک
  const name = storage.writePrivate(DATA_DIR, TINY_PDF, new Date());
  db.prepare(`INSERT INTO answer_keys (exam_id, original_name, mime_type, size_bytes, sha256, storage_name, uploaded_at)
              VALUES (?, 'key.pdf', 'application/pdf', ?, ?, ?, ?)`)
    .run(ex.id, TINY_PDF.length, require('crypto').createHash('sha256').update(TINY_PDF).digest('hex'), name, iso(0));

  if (status !== 'draft') examsSvc.transition(db, ex.id, 'published', { now: new Date(Date.now() - 9 * HOUR) });
  return ex.id;
}

/** جابه‌جا کردنِ زمان‌بندیِ یک آزمونِ ازقبل‌منتشرشده (برای ساختنِ سناریو). */
function shiftExam(id, { startsAt, deadline }) {
  const end = new Date(deadline).getTime();
  db.prepare('UPDATE exams SET starts_at=?, submission_deadline=?, answer_key_publish_at=?, results_publish_at=? WHERE id=?')
    .run(startsAt, deadline, new Date(end + 2 * HOUR).toISOString(), new Date(end + 4 * HOUR).toISOString(), id);
}

if (db.prepare('SELECT COUNT(*) n FROM exams').get().n === 0) {
  // همه با یک زمان‌بندیِ معتبرِ آینده ساخته می‌شوند، بعد زمان‌ها جابه‌جا می‌شود
  const a = makeExam({ title: 'آزمون مرحله اول', startsAt: iso(2 * HOUR), deadline: iso(8 * HOUR) });
  const b = makeExam({ title: 'آزمون مرحله دوم', startsAt: iso(2 * HOUR), deadline: iso(8 * HOUR) });
  const c = makeExam({ title: 'آزمون مرحله سوم', startsAt: iso(2 * HOUR), deadline: iso(8 * HOUR) });
  shiftExam(a, { startsAt: iso(-2 * HOUR), deadline: iso(6 * HOUR) });       // در حال برگزاری
  shiftExam(b, { startsAt: iso(48 * HOUR), deadline: iso(52 * HOUR) });      // آینده
  shiftExam(c, { startsAt: iso(-96 * HOUR), deadline: iso(-90 * HOUR) });    // منقضی‌شده
  console.log('  ۳ آزمون (درحال‌برگزاری / آینده / منقضی‌شده)');
}

// ------------------------------------------------------------------ برنامه راهبردی
if (db.prepare('SELECT COUNT(*) n FROM strategic_phases').get().n === 0) {
  const phases = [
    ['مرحله اول', -24 * HOUR, 8 * HOUR, 'زیست فصل ۱ و ۲ • شیمی فصل ۱', 'target'],
    ['مرحله دوم', 48 * HOUR, 72 * HOUR, 'فیزیک فصل ۱ • ریاضی فصل ۲', 'star'],
    ['مرحله سوم', 120 * HOUR, 144 * HOUR, 'زیست فصل ۳ • شیمی فصل ۲', 'medal'],
  ];
  for (const [i, [title, from, to, topics, ic]] of phases.entries()) {
    db.prepare(`INSERT INTO strategic_phases (title, grade_id, starts_at, ends_at, sort_order, active, topics_text, icon, accent, created_at, updated_at)
                VALUES (?,?,?,?,?,1,?,?,?,?,?)`)
      .run(title, gradeIds.g10, iso(from), iso(to), i + 1, topics, ic, '#1E7A46', iso(0), iso(0));
  }
  console.log('  ۳ مرحله‌ی برنامه راهبردی');
}

console.log('\nآماده است. سرور را اجرا کن:');
console.log('  DB_PATH=' + DB_PATH + ' DATA_DIR=' + DATA_DIR + ' PORT=3000 HOST=0.0.0.0 PUBLIC_ORIGIN=http://localhost:3000 npm start');
db.close();
