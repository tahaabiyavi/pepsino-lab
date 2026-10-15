'use strict';
/**
 * مجموعه تمرین (Practice Set)
 * ------------------------------------------------
 * منطق کامل و ایزوله از نتایج رسمی:
 * - ادمین مجموعه‌های تمرین را با عنوان، پایه، درس و لیست سؤالات می‌سازد.
 * - هر سؤال دارای متن، حداکثر نمره و پاسخ تشریحی اختیاری است.
 * - دانش‌آموز مجموعه را شروع می‌کند، به سؤالات پاسخ می‌دهد (خودارزیابی) و
 *   نمرهٔ خود را با گام ۰.۲۵ ثبت می‌کند.
 * - پس از ارسال، پاسخ‌نامهٔ تشریحی نمایش داده می‌شود.
 * - نمرات تمرین هرگز در رتبه‌بندی، کارنامه، تاریخچه نمره یا تصحیح رسمی
 *   خوانده نمی‌شوند (جداول جداگانه: practice_sets / practice_questions /
 *   practice_attempts / practice_scores).
 *
 * این بخش طبق درخواست حفظ و در صورت نیاز قابل بهبود است.
 */
// Practice mode. Completely isolated from official results: practice tables only.
// Students self-assess practice answers; those scores are never read by the
// ranking, report card, score history, or grading code.
const { badRequest, conflict, notFound, forbidden } = require('./errors');
const { parseMarkToQuarters, validateScoreQuarters, formatQuarters, MAX_QUESTION_QUARTERS, MAX_TOTAL_QUARTERS } = require('./marks');
const { recordAudit } = require('./audit');

function createPracticeSet(db, { title, gradeCode, subjectId, questions }, { now = new Date(), actor = 'admin' } = {}) {
  const errors = {};
  const t = typeof title === 'string' ? title.trim() : '';
  if (t.length < 3 || t.length > 150) errors.title = 'عنوان باید بین ۳ تا ۱۵۰ کاراکتر باشد';
  const grade = db.prepare('SELECT id FROM grades WHERE code = ? AND active = 1').get(String(gradeCode));
  if (!grade) errors.gradeCode = 'پایه نامعتبر است';
  const subject = db.prepare('SELECT id FROM subjects WHERE id = ? AND active = 1').get(subjectId);
  if (!subject) errors.subjectId = 'درس نامعتبر است';
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 100) errors.questions = 'تعداد سؤال‌ها باید بین ۱ تا ۱۰۰ باشد';
  const parsed = [];
  if (Array.isArray(questions)) {
    questions.forEach((q, i) => {
      const body = typeof q.body === 'string' ? q.body.trim() : '';
      if (!body || body.length > 5000) errors[`questions[${i}].body`] = 'متن سؤال الزامی است';
      try {
        const max = parseMarkToQuarters(q.maxMark);
        if (max <= 0) errors[`questions[${i}].maxMark`] = 'حداکثر نمره باید بزرگ‌تر از صفر باشد';
        parsed.push({ body, max, explanation: q.explanatoryAnswer ? String(q.explanatoryAnswer).slice(0, 5000) : null });
      } catch (e) { errors[`questions[${i}].maxMark`] = e.message; }
    });
  }
  if (Object.keys(errors).length) throw badRequest('validation_failed', 'اطلاعات مجموعه‌ی تمرین معتبر نیست', errors);
  return db.transaction(() => {
    const info = db.prepare('INSERT INTO practice_sets (title, grade_id, subject_id, active, created_at, created_by) VALUES (?, ?, ?, 1, ?, ?)')
      .run(t, grade.id, subject.id, now.toISOString(), actor);
    const setId = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO practice_questions (set_id, position, body, max_quarters, explanatory_answer) VALUES (?, ?, ?, ?, ?)');
    parsed.forEach((p, i) => ins.run(setId, i + 1, p.body, p.max, p.explanation));
    recordAudit(db, { actor, action: 'practice_set.created', entityType: 'practice_set', entityId: setId, details: { questions: parsed.length } }, now);
    return { id: setId, questionCount: parsed.length };
  })();
}

function setActive(db, setId, active, { now = new Date(), actor = 'admin' } = {}) {
  const r = db.prepare('UPDATE practice_sets SET active = ? WHERE id = ?').run(active ? 1 : 0, setId);
  if (r.changes === 0) throw notFound('مجموعه‌ی تمرین یافت نشد');
  recordAudit(db, { actor, action: active ? 'practice_set.activated' : 'practice_set.deactivated', entityType: 'practice_set', entityId: setId }, now);
  return { id: setId, active: Boolean(active) };
}

function listPracticeSetsForAdmin(db) {
  return db.prepare(
    `SELECT p.id, p.title, p.active, g.code AS grade_code, s.label AS subject,
            (SELECT COUNT(*) FROM practice_questions q WHERE q.set_id = p.id) AS question_count
       FROM practice_sets p JOIN grades g ON g.id = p.grade_id JOIN subjects s ON s.id = p.subject_id
      ORDER BY p.id DESC`
  ).all();
}

function listPracticeSetsForStudent(db, studentId) {
  return db.prepare(
    `SELECT p.id, p.title, s.label AS subject,
            (SELECT COUNT(*) FROM practice_questions q WHERE q.set_id = p.id) AS question_count
       FROM practice_sets p
       JOIN students st ON st.id = ? AND st.grade_id = p.grade_id
       JOIN subjects s ON s.id = p.subject_id
      WHERE p.active = 1 AND st.status = 'active'
      ORDER BY p.id DESC`
  ).all(studentId);
}

function studentSet(db, setId, studentId) {
  const st = db.prepare("SELECT grade_id FROM students WHERE id = ? AND status = 'active'").get(studentId);
  const set = db.prepare('SELECT * FROM practice_sets WHERE id = ?').get(setId);
  if (!set || !st || !set.active || set.grade_id !== st.grade_id) throw notFound('مجموعه‌ی تمرین یافت نشد');
  return set;
}

/** Practice set for a student. Explanatory answers are hidden until the attempt is submitted. */
function getPracticeSetForStudent(db, setId, studentId) {
  const set = studentSet(db, setId, studentId);
  const questions = db.prepare('SELECT id, position, body, max_quarters FROM practice_questions WHERE set_id = ? ORDER BY position').all(setId)
    .map((q) => ({ id: q.id, position: q.position, body: q.body, maxMark: formatQuarters(q.max_quarters) }));
  return { id: set.id, title: set.title, questions };
}

function startAttempt(db, setId, studentId, { now = new Date() } = {}) {
  return db.transaction(() => {
    studentSet(db, setId, studentId);
    const open = db.prepare('SELECT id FROM practice_attempts WHERE set_id = ? AND student_id = ? AND submitted_at IS NULL').get(setId, studentId);
    if (open) return { attemptId: open.id, resumed: true };
    const info = db.prepare('INSERT INTO practice_attempts (set_id, student_id, started_at) VALUES (?, ?, ?)')
      .run(setId, studentId, now.toISOString());
    return { attemptId: Number(info.lastInsertRowid), resumed: false };
  })();
}

function ownAttempt(db, attemptId, studentId) {
  const a = db.prepare('SELECT * FROM practice_attempts WHERE id = ?').get(attemptId);
  if (!a) throw notFound('تلاش یافت نشد');
  if (a.student_id !== studentId) throw forbidden('این تلاش متعلق به شما نیست');
  return a;
}

/** Autosave self-assessed practice scores. Each value is validated against the question maximum. */
function saveAttemptScores(db, attemptId, studentId, scores, { now = new Date() } = {}) {
  return db.transaction(() => {
    const a = ownAttempt(db, attemptId, studentId);
    if (a.submitted_at) throw conflict('attempt_submitted', 'این تلاش نهایی شده است');
    if (!Array.isArray(scores)) throw badRequest('invalid_scores', 'فرمت نمره‌ها نامعتبر است');
    const questions = new Map(db.prepare('SELECT id, max_quarters FROM practice_questions WHERE set_id = ?').all(a.set_id).map((q) => [q.id, q]));
    const parsed = [];
    const errors = [];
    for (const s of scores) {
      const q = questions.get(Number(s.questionId));
      if (!q) { errors.push({ questionId: s.questionId, message: 'سؤال نامعتبر است' }); continue; }
      try {
        parsed.push({ questionId: q.id, quarters: validateScoreQuarters(parseMarkToQuarters(s.mark), q.max_quarters) });
      } catch (e) { errors.push({ questionId: s.questionId, message: e.message }); }
    }
    if (errors.length) throw badRequest('invalid_scores', 'بعضی نمره‌ها معتبر نیستند', { errors });
    const up = db.prepare(`INSERT INTO practice_scores (attempt_id, question_id, quarters, updated_at) VALUES (?, ?, ?, ?)
                           ON CONFLICT(attempt_id, question_id) DO UPDATE SET quarters = excluded.quarters, updated_at = excluded.updated_at`);
    for (const p of parsed) up.run(attemptId, p.questionId, p.quarters, now.toISOString());
    return { saved: parsed.length };
  })();
}

function submitAttempt(db, attemptId, studentId, { now = new Date() } = {}) {
  return db.transaction(() => {
    const a = ownAttempt(db, attemptId, studentId);
    if (a.submitted_at) throw conflict('attempt_submitted', 'این تلاش قبلاً نهایی شده است');
    db.prepare('UPDATE practice_attempts SET submitted_at = ? WHERE id = ?').run(now.toISOString(), attemptId);
    return practiceResult(db, attemptId);
  })();
}

function practiceResult(db, attemptId) {
  const a = db.prepare('SELECT * FROM practice_attempts WHERE id = ?').get(attemptId);
  const rows = db.prepare(
    `SELECT q.id, q.position, q.body, q.max_quarters, q.explanatory_answer, ps.quarters
       FROM practice_questions q
       LEFT JOIN practice_scores ps ON ps.question_id = q.id AND ps.attempt_id = ?
      WHERE q.set_id = ? ORDER BY q.position`
  ).all(attemptId, a.set_id);
  const total = rows.reduce((s, r) => s + (r.quarters || 0), 0);
  const max = rows.reduce((s, r) => s + r.max_quarters, 0);
  const done = Boolean(a.submitted_at);
  return {
    attemptId,
    submitted: done,
    selfTotal: formatQuarters(total),
    selfMaxTotal: formatQuarters(max),
    questions: rows.map((r) => ({
      id: r.id,
      position: r.position,
      body: r.body,
      maxMark: formatQuarters(r.max_quarters),
      selfMark: r.quarters === null ? null : formatQuarters(r.quarters),
      explanatoryAnswer: done ? r.explanatory_answer : undefined,
    })),
  };
}

function getAttemptForStudent(db, attemptId, studentId) {
  ownAttempt(db, attemptId, studentId);
  return practiceResult(db, attemptId);
}

/* ==================================================================
 * تبدیل آزمون منقضی‌شده به مجموعه تمرین
 * ------------------------------------------------------------------
 * وقتی مهلتِ ارسالِ یک آزمون می‌گذرد، دانش‌آموز دیگر نمی‌تواند در آن شرکت
 * کند. با این تبدیل، همان سؤالات به یک مجموعه تمرین تبدیل می‌شود تا
 * دانش‌آموز بتواند آن‌ها را به‌صورت تمرینی حل کند. نمره‌های تمرینی هرگز
 * وارد کارنامه، رتبه‌بندی یا تاریخچه نمره نمی‌شوند (جداول جداگانه).
 * ================================================================== */

/** آزمون‌هایی که مهلت ارسال‌شان گذشته و هنوز تبدیل نشده‌اند. */
function listExpiredExams(db, { now = new Date() } = {}) {
  const iso = now.toISOString();
  const rows = db.prepare(`
    SELECT e.id, e.title, e.status, e.starts_at, e.submission_deadline,
           e.question_count, e.total_quarters,
           (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS question_rows,
           (SELECT COUNT(*) FROM exam_question_files f WHERE f.exam_id = e.id) AS has_file,
           (SELECT COUNT(*) FROM exam_practice_conversions c WHERE c.exam_id = e.id) AS converted
    FROM exams e
    WHERE e.submission_deadline <= ?
      AND e.status NOT IN ('draft', 'archived')
    ORDER BY e.submission_deadline DESC
  `).all(iso);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    startsAt: r.starts_at,
    submissionDeadline: r.submission_deadline,
    questionCount: r.question_count || r.question_rows || null,
    source: r.has_file > 0 && r.question_rows === 0 ? 'file' : 'rows',
    converted: r.converted > 0,
  }));
}

/**
 * یک آزمون منقضی‌شده را به یک یا چند مجموعه تمرین تبدیل می‌کند
 * (به ازای هر پایه‌ی آزمون یک مجموعه، چون practice_sets فقط یک پایه دارد).
 * تکرارِ اجرا امن است: اگر قبلاً تبدیل شده باشد، همان نتیجه برمی‌گردد.
 */
function convertExamToPractice(db, examId, { now = new Date(), actor = 'admin' } = {}) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) throw notFound('آزمون یافت نشد');
  if (new Date(exam.submission_deadline) > now) {
    throw conflict('exam_not_expired', 'مهلت ارسال این آزمون هنوز تمام نشده است');
  }
  if (exam.status === 'draft') throw conflict('exam_draft', 'آزمون پیش‌نویس قابل تبدیل نیست');

  const existing = db.prepare('SELECT practice_set_id FROM exam_practice_conversions WHERE exam_id = ?').all(examId);
  if (existing.length) {
    return { examId, alreadyConverted: true, sets: existing.map((r) => ({ id: r.practice_set_id })) };
  }

  const questionRows = db.prepare('SELECT id, position, subject_id, body, max_quarters, explanatory_answer FROM questions WHERE exam_id = ? ORDER BY position').all(examId);
  const fileRow = db.prepare('SELECT id FROM exam_question_files WHERE exam_id = ?').get(examId);
  const qCount = exam.question_count || questionRows.length;
  if (!(qCount > 0) && !fileRow) {
    throw conflict('exam_has_no_questions', 'این آزمون هیچ سؤالی ندارد که به تمرین تبدیل شود');
  }
  const effectiveCount = qCount > 0 ? qCount : (fileRow ? 1 : 0);

  const grades = db.prepare('SELECT grade_id FROM exam_grades WHERE exam_id = ?').all(examId).map((r) => r.grade_id);
  if (!grades.length) throw conflict('exam_no_grades', 'این آزمون هیچ پایه‌ای ندارد');

  // درسِ مجموعه: اولویت با درس‌های آزمون، بعد درسِ اولین سؤال، بعد اولین درسِ فعال
  let subjectId = (db.prepare('SELECT subject_id FROM exam_subjects WHERE exam_id = ?').get(examId) || {}).subject_id
    || (questionRows[0] || {}).subject_id
    || (db.prepare('SELECT id FROM subjects WHERE active = 1 ORDER BY id LIMIT 1').get() || {}).id;
  if (!subjectId) throw conflict('no_subject', 'هیچ درس فعالی برای ساخت مجموعه تمرین وجود ندارد');

  // بارمِ هر سؤال: اگر تعداد سؤال مشخص باشد، سهم هر سؤال از سقف ۲۰ نمره (۸۰ کوارتر)
  // با رعایت سقف ۲ نمره برای هر سؤال محاسبه می‌شود.
  const perQuestionQuarters = Math.max(1, Math.min(MAX_QUESTION_QUARTERS, Math.floor(MAX_TOTAL_QUARTERS / Math.max(1, effectiveCount))));

  const iso = now.toISOString();
  const gradeLabels = {};
  for (const r of db.prepare('SELECT id, label FROM grades').all()) gradeLabels[r.id] = r.label;

  return db.transaction(() => {
    const sets = [];
    for (const gradeId of grades) {
      const suffix = grades.length > 1 ? ` — ${gradeLabels[gradeId] || ''}`.trimEnd() : '';
      const title = `${exam.title} (تمرینی)${suffix}`.slice(0, 150);
      const info = db.prepare(
        'INSERT INTO practice_sets (title, grade_id, subject_id, active, created_at, created_by, source_exam_id) VALUES (?, ?, ?, 1, ?, ?, ?)'
      ).run(title, gradeId, subjectId, iso, actor, examId);
      const setId = Number(info.lastInsertRowid);
      const ins = db.prepare('INSERT INTO practice_questions (set_id, position, body, max_quarters, explanatory_answer) VALUES (?, ?, ?, ?, ?)');

      if (questionRows.length) {
        // سؤالاتِ ثبت‌شده عیناً کپی می‌شوند
        for (const q of questionRows) {
          ins.run(setId, q.position, q.body, Math.min(q.max_quarters, MAX_QUESTION_QUARTERS), q.explanatory_answer);
        }
      } else {
        // آزمونِ مبتنی بر فایل سؤالات: به تعدادِ اعلام‌شده سؤالِ شماره‌دار می‌سازیم
        for (let i = 1; i <= effectiveCount; i++) {
          ins.run(setId, i, `سؤال ${i}`, perQuestionQuarters, null);
        }
      }

      db.prepare(`INSERT INTO exam_practice_conversions (exam_id, practice_set_id, question_count, answer_key_shared, converted_by, converted_at)
                  VALUES (?, ?, ?, 1, ?, ?)`).run(examId, setId, effectiveCount, actor, iso);
      recordAudit(db, {
        actor, action: 'exam.converted_to_practice', entityType: 'exam', entityId: examId,
        details: { practiceSetId: setId, questionCount: effectiveCount, gradeId },
      }, now);
      sets.push({ id: setId, gradeId, title, questionCount: effectiveCount });
    }
    return { examId, alreadyConverted: false, sets };
  })();
}

/** آزمونِ مبدأِ یک مجموعه تمرین (اگر داشته باشد). */
function practiceSetSourceExam(db, setId) {
  const row = db.prepare('SELECT source_exam_id FROM practice_sets WHERE id = ?').get(setId);
  if (!row || !row.source_exam_id) return null;
  const conv = db.prepare('SELECT * FROM exam_practice_conversions WHERE practice_set_id = ?').get(setId);
  return {
    examId: row.source_exam_id,
    answerKeyShared: conv ? conv.answer_key_shared === 1 : false,
    questionCount: conv ? conv.question_count : null,
  };
}

module.exports = {
  createPracticeSet, setActive, listPracticeSetsForAdmin, listPracticeSetsForStudent,
  getPracticeSetForStudent, startAttempt, saveAttemptScores, submitAttempt, getAttemptForStudent,
  listExpiredExams, convertExamToPractice, practiceSetSourceExam,
};
