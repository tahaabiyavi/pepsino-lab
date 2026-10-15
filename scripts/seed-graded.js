'use strict';
/**
 * یک سناریوی کاملِ تصحیح برای دیدنِ کارنامه در مرورگر:
 * ثبت پاسخ برخی دانش‌آموزان → بسته‌شدن پنجره → توزیع بین مصحح‌ها →
 * نمره‌دهی → نهایی‌سازی → انتشار نتایج.
 *
 *   node scripts/seed-graded.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pepsino.sqlite');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const exams = require('../src/services/exams');
const grading = require('../src/services/grading');
const accounts = require('../src/services/accounts');
const publication = require('../src/services/publication');

const now = new Date();
const HOUR = 3600e3;
const iso = (ms) => new Date(now.getTime() + ms).toISOString();

const examId = Number(process.argv[2]) || 1;
const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
if (!exam) { console.error('آزمون یافت نشد'); process.exit(1); }

console.log(`آزمون: ${exam.title} (وضعیت: ${exam.status})`);

// ------------------------------------------------------------------ دانش‌آموزان
const students = db.prepare("SELECT id, full_name FROM students WHERE status='active' ORDER BY id").all();
const takers = students.slice(0, 3);          // سه نفر پاسخ می‌دهند
const gradersNeeded = 1;

// ------------------------------------------------------------------ مصحح
// فقط یک مصحح می‌سازیم تا همهٔ برگه‌ها به او تخصیص داده شود
let grader = db.prepare('SELECT id, username FROM grader_profiles WHERE username = ?').get('grader_demo');
if (!grader) {
  grader = accounts.createGraderAccount(
    db,
    { displayName: 'مصحح نمونه', username: 'grader_demo', password: 'GraderPass1' },
    { rounds: 4 },
  );
  console.log('  مصحح ساخته شد');
}
console.log(`  حساب مصحح: ${grader.username} / GraderPass1`);

// ------------------------------------------------------------------ ثبت پاسخ
// اگر آزمون هنوز باز است، مهلت را به گذشته می‌بریم تا پنجره بسته شود
db.prepare('UPDATE exams SET starts_at=?, submission_deadline=?, answer_key_publish_at=?, results_publish_at=? WHERE id=?')
  .run(iso(-6 * HOUR), iso(-1 * HOUR), iso(-0.5 * HOUR), iso(0.2 * HOUR), examId);

for (const s of takers) {
  try {
    exams.recordSubmission(db, examId, s.id, { now: new Date(now.getTime() - 2 * HOUR) });
    console.log(`  پاسخ ثبت شد: ${s.full_name}`);
  } catch (e) { console.log(`  رد شد ${s.full_name}: ${e.message}`); }
}

// ------------------------------------------------------------------ بستن و توزیع
console.log('  اجرای زمان‌بند (بستن پنجره و توزیع)…');
publication.tick(db, now);

const qRows = db.prepare('SELECT id, max_quarters FROM questions WHERE exam_id = ? ORDER BY position').all(examId);
// فقط برگه‌های همین آزمون را تصحیح می‌کنیم
const assignments = db.prepare(`
  SELECT ga.id, ga.grader_id FROM grading_assignments ga
    JOIN submissions s ON s.id = ga.submission_id
   WHERE s.exam_id = ? AND ga.state = 'active'
`).all(examId);
console.log(`  ${assignments.length} برگه برای تصحیح توزیع شد`);

// ------------------------------------------------------------------ نمره‌دهی
const marks = ['2', '1.75', '1.25'];   // نمره‌های نمونه برای سه نفر
let i = 0;
for (const a of assignments) {
  // نمره به‌صورت «ربع» است: نمره‌ی نهاییِ هر سؤال = quarters / 4
  const scores = qRows.map((q, idx) => {
    const maxQ = Number(q.max_quarters || 8);
    const factor = [0.9, 0.8, 0.65][i % 3];
    return { questionId: q.id, mark: String((Math.round(maxQ * factor) / 4).toFixed(2)) };
  });
  try {
    const gid = a.grader_id || grader.id;
    grading.saveScores(db, a.id, gid, { scores }, { now });
    grading.finalizeAssignment(db, a.id, gid, { now });
    i++;
  } catch (e) { console.log('  خطا در نمره‌دهی:', e.message); }
}
console.log(`  ${i} برگه نمره‌دهی و نهایی شد`);

// ------------------------------------------------------------------ انتشار نتایج
console.log('  اجرای زمان‌بند (انتشار پاسخنامه و نتایج)…');
publication.tick(db, new Date(now.getTime() + 30 * 60e3));

const after = db.prepare('SELECT status, results_published_at FROM exams WHERE id = ?').get(examId);
console.log(`\nوضعیت نهایی آزمون: ${after.status}${after.results_published_at ? ' (نتایج منتشر شد)' : ''}`);

const ranked = db.prepare(`
  SELECT s.student_id, st.full_name,
         (SELECT COALESCE(SUM(qs.quarters),0) FROM question_scores qs
            JOIN grading_assignments ga ON ga.id = qs.assignment_id
           WHERE ga.submission_id = s.id) AS q
    FROM submissions s JOIN students st ON st.id = s.student_id
   WHERE s.exam_id = ? AND s.status='submitted'
   ORDER BY q DESC`).all(examId);
for (const r of ranked) console.log(`  ${r.full_name}: ${(r.q / 4).toFixed(2)} از ۲۰`);

console.log('\nحالا با stu1 وارد شو و تب «کارنامه من» را ببین، یا دکمهٔ چاپ را بزن.');
db.close();
