'use strict';
// Examination management: creation, questions, pre-publication validation,
// the explicit lifecycle state machine, and server-enforced submission rules.
const { badRequest, conflict, notFound } = require('./errors');
const { recordAudit } = require('./audit');
const { parseMarkToQuarters } = require('./marks');

// Allowed transitions. Anything else is rejected by the backend.
const TRANSITIONS = {
  draft: ['published'],
  published: ['in_progress', 'submission_closed'],
  in_progress: ['submission_closed'],
  submission_closed: ['grading'],
  grading: ['results_published'],
  results_published: ['archived'],
  archived: [],
};

const iso = (d) => new Date(d).toISOString();
const parseTime = (v, field) => {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw badRequest('invalid_time', `${field} نامعتبر است`, { [field]: 'invalid' });
  return new Date(t);
};

function createExam(db, input, { now = new Date(), actor = 'admin' } = {}) {
  const errors = {};
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length < 3 || title.length > 150) errors.title = 'عنوان آزمون باید بین ۳ تا ۱۵۰ کاراکتر باشد';
  const duration = Number(input.durationMinutes);
  if (!Number.isInteger(duration) || duration < 5 || duration > 300) errors.durationMinutes = 'مدت آزمون باید بین ۵ تا ۳۰۰ دقیقه باشد';
  const gradeCodes = Array.isArray(input.gradeCodes) ? input.gradeCodes : [];
  if (gradeCodes.length === 0) errors.gradeCodes = 'حداقل یک پایه باید انتخاب شود';
  if (Object.keys(errors).length) throw badRequest('validation_failed', 'اطلاعات آزمون معتبر نیست', errors);

  const times = {
    startsAt: parseTime(input.startsAt, 'startsAt'),
    submissionDeadline: parseTime(input.submissionDeadline, 'submissionDeadline'),
    answerKeyPublishAt: parseTime(input.answerKeyPublishAt, 'answerKeyPublishAt'),
    resultsPublishAt: parseTime(input.resultsPublishAt, 'resultsPublishAt'),
  };
  validateSchedule(times);

  return db.transaction(() => {
    const year = db.prepare('SELECT id FROM academic_years WHERE id = ?').get(input.academicYearId);
    if (!year) throw badRequest('validation_failed', 'سال تحصیلی نامعتبر است', { academicYearId: 'invalid' });

    const grades = resolveCodes(db, 'grades', gradeCodes);
    const fieldCodes = Array.isArray(input.fieldCodes) ? input.fieldCodes : [];
    const fields = fieldCodes.length ? resolveCodes(db, 'academic_fields', fieldCodes) : [];
    const subjectIds = Array.isArray(input.subjectIds) ? input.subjectIds : [];

    const nowIso = now.toISOString();
    const info = db.prepare(
      `INSERT INTO exams (title, academic_year_id, status, instructions, starts_at, duration_minutes,
         submission_deadline, answer_key_publish_at, results_publish_at, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(title, year.id, input.instructions ? String(input.instructions).slice(0, 5000) : null,
      iso(times.startsAt), duration, iso(times.submissionDeadline), iso(times.answerKeyPublishAt),
      iso(times.resultsPublishAt), nowIso, nowIso);
    const examId = Number(info.lastInsertRowid);

    for (const g of grades) db.prepare('INSERT INTO exam_grades (exam_id, grade_id) VALUES (?, ?)').run(examId, g.id);
    for (const f of fields) db.prepare('INSERT INTO exam_fields (exam_id, field_id) VALUES (?, ?)').run(examId, f.id);
    for (const sid of subjectIds) {
      const s = db.prepare('SELECT id FROM subjects WHERE id = ? AND active = 1').get(sid);
      if (!s) throw badRequest('validation_failed', 'درس نامعتبر است', { subjectIds: 'invalid' });
      db.prepare('INSERT OR IGNORE INTO exam_subjects (exam_id, subject_id) VALUES (?, ?)').run(examId, s.id);
    }
    recordAudit(db, { actor, action: 'exam.created', entityType: 'exam', entityId: examId, details: { title } }, now);
    return { id: examId, status: 'draft' };
  })();
}

/**
 * پایانِ «مدتِ آزمون» برای دانش‌آموز — همان چیزی که شمارش معکوسِ صفحه‌ی
 * آزمون به آن می‌رسد. این با submission_deadline فرق دارد: مهلتِ ارسال
 * پنجره‌ای است که مدیر برای بارگذاری باز می‌گذارد (مثلاً تا فردا)، اما
 * دانش‌آموز فقط به اندازه‌ی duration_minutes وقتِ حل دارد.
 *
 * هر کدام زودتر برسد ملاک است، تا هیچ‌وقت بیش از مهلتِ ارسال وقت داده نشود.
 *
 * @returns {string|null} ISO یا null اگر زمانِ شروع معلوم نباشد
 */
function allowedUntil(exam) {
  if (!exam || !exam.starts_at) return null;
  const start = new Date(exam.starts_at).getTime();
  if (Number.isNaN(start)) return null;
  const byDuration = start + (Number(exam.duration_minutes) || 0) * 60000;
  const deadline = exam.submission_deadline ? new Date(exam.submission_deadline).getTime() : Infinity;
  const ms = Math.min(byDuration, Number.isNaN(deadline) ? byDuration : deadline);
  return new Date(ms).toISOString();
}

/**
 * ویرایشِ مشخصاتِ آزمون: عنوان، مدت، توضیحات و (اختیاری) پایه‌ها/رشته‌ها/درس‌ها.
 * زمان‌بندی را تغییر نمی‌دهد — برای آن updateSchedule را صدا بزن.
 * آزمونِ بایگانی‌شده دیگر قابل ویرایش نیست.
 */
function updateExam(db, examId, input, { now = new Date(), actor = 'admin' } = {}) {
  return db.transaction(() => {
    const exam = getExam(db, examId);
    if (exam.status === 'archived') throw conflict('exam_locked', 'آزمون بایگانی‌شده قابل ویرایش نیست');

    const errors = {};
    let title = exam.title;
    if (input.title !== undefined) {
      title = String(input.title).trim();
      if (title.length < 3 || title.length > 150) errors.title = 'عنوان آزمون باید بین ۳ تا ۱۵۰ کاراکتر باشد';
    }
    let duration = exam.duration_minutes;
    if (input.durationMinutes !== undefined && input.durationMinutes !== null && input.durationMinutes !== '') {
      duration = Number(input.durationMinutes);
      if (!Number.isInteger(duration) || duration < 5 || duration > 300) {
        errors.durationMinutes = 'مدت آزمون باید عددی صحیح بین ۵ تا ۳۰۰ دقیقه باشد';
      }
    }
    if (Object.keys(errors).length) throw badRequest('validation_failed', 'اطلاعات آزمون معتبر نیست', errors);

    const instructions = input.instructions !== undefined
      ? (input.instructions ? String(input.instructions).slice(0, 5000) : null)
      : exam.instructions;

    const before = { title: exam.title, duration_minutes: exam.duration_minutes };

    // پایه‌ها / رشته‌ها / درس‌ها — فقط اگر فرستاده شده باشند
    if (Array.isArray(input.gradeCodes) && input.gradeCodes.length) {
      const grades = resolveCodes(db, 'grades', input.gradeCodes);
      db.prepare('DELETE FROM exam_grades WHERE exam_id = ?').run(examId);
      for (const g of grades) db.prepare('INSERT INTO exam_grades (exam_id, grade_id) VALUES (?, ?)').run(examId, g.id);
    }
    if (Array.isArray(input.fieldCodes)) {
      const fields = input.fieldCodes.length ? resolveCodes(db, 'academic_fields', input.fieldCodes) : [];
      db.prepare('DELETE FROM exam_fields WHERE exam_id = ?').run(examId);
      for (const f of fields) db.prepare('INSERT INTO exam_fields (exam_id, field_id) VALUES (?, ?)').run(examId, f.id);
    }
    if (Array.isArray(input.subjectIds)) {
      db.prepare('DELETE FROM exam_subjects WHERE exam_id = ?').run(examId);
      for (const sid of input.subjectIds) {
        const s = db.prepare('SELECT id FROM subjects WHERE id = ? AND active = 1').get(sid);
        if (!s) throw badRequest('validation_failed', 'درس نامعتبر است', { subjectIds: 'invalid' });
        db.prepare('INSERT OR IGNORE INTO exam_subjects (exam_id, subject_id) VALUES (?, ?)').run(examId, s.id);
      }
    }

    db.prepare(
      `UPDATE exams SET title = ?, duration_minutes = ?, instructions = ?, updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(title, duration, instructions, now.toISOString(), examId);

    db.prepare(
      'INSERT INTO exam_change_log (exam_id, change_type, details, actor, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(examId, 'exam_edited', JSON.stringify({
      before, after: { title, duration_minutes: duration },
    }), actor, now.toISOString());

    recordAudit(db, {
      actor, action: 'exam.updated', entityType: 'exam', entityId: examId,
      details: { title, duration_minutes: duration },
    }, now);

    return getExam(db, examId);
  })();
}

/**
 * حذفِ کاملِ یک آزمون به‌همراهِ فایل‌های روی دیسک.
 * بیشترِ جداول با ON DELETE CASCADE پاک می‌شوند؛ practice_sets و
 * strategic_phases فقط لینکشان را از دست می‌دهند (SET NULL) و باقی می‌مانند.
 */
function deleteExam(db, examId, { actor = 'admin', dataDir = null } = {}) {
  return db.transaction(() => {
    const exam = getExam(db, examId);

    // جمع‌آوریِ فایل‌های روی دیسک پیش از حذفِ ردیف‌ها
    const storageNames = [];
    const collect = (sql, ...params) => {
      for (const r of db.prepare(sql).all(...params)) if (r.storage_name) storageNames.push(r.storage_name);
    };
    collect('SELECT storage_name FROM exam_question_files WHERE exam_id = ?', examId);
    collect('SELECT storage_name FROM answer_keys WHERE exam_id = ?', examId);
    collect(
      `SELECT storage_name FROM submission_files
        WHERE submission_id IN (SELECT id FROM submissions WHERE exam_id = ?)`, examId);

    const counts = {
      questions: db.prepare('SELECT COUNT(*) n FROM questions WHERE exam_id = ?').get(examId).n,
      submissions: db.prepare('SELECT COUNT(*) n FROM submissions WHERE exam_id = ?').get(examId).n,
    };

    db.prepare('DELETE FROM exams WHERE id = ?').run(examId);

    recordAudit(db, {
      actor, action: 'exam.deleted', entityType: 'exam', entityId: examId,
      details: { title: exam.title, ...counts, files: storageNames.length },
    }, new Date());

    return { id: examId, title: exam.title, ...counts, storageNames };
  })();
}

function resolveCodes(db, table, codes) {
  const out = [];
  for (const code of codes) {
    const row = db.prepare(`SELECT id FROM ${table} WHERE code = ? AND active = 1`).get(String(code));
    if (!row) throw badRequest('validation_failed', 'مقدار نامعتبر است', { [table]: String(code) });
    out.push(row);
  }
  return out;
}

function validateSchedule({ startsAt, submissionDeadline, answerKeyPublishAt, resultsPublishAt }) {
  const errors = {};
  if (startsAt >= submissionDeadline) errors.submissionDeadline = 'مهلت ارسال باید بعد از زمان شروع باشد';
  if (answerKeyPublishAt < submissionDeadline) errors.answerKeyPublishAt = 'انتشار پاسخنامه نمی‌تواند قبل از پایان مهلت باشد';
  if (resultsPublishAt < answerKeyPublishAt) errors.resultsPublishAt = 'انتشار نتایج نمی‌تواند قبل از پاسخنامه باشد';
  if (Object.keys(errors).length) throw badRequest('invalid_schedule', 'زمان‌بندی آزمون معتبر نیست', errors);
}

function getExam(db, examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) throw notFound('آزمون یافت نشد');
  return exam;
}

function addQuestion(db, examId, input, { now = new Date(), actor = 'admin' } = {}) {
  return db.transaction(() => {
    const exam = getExam(db, examId);
    if (exam.status !== 'draft') {
      // Question edits after publication are blocked. Publishing freezes the paper.
      throw conflict('exam_locked', 'سؤالات آزمون منتشرشده قابل ویرایش نیست');
    }
    const errors = {};
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (!body || body.length > 5000) errors.body = 'متن سؤال الزامی است (حداکثر ۵۰۰۰ کاراکتر)';
    let maxQ = null;
    try { maxQ = parseMarkToQuarters(input.maxMark); } catch (e) { errors.maxMark = e.message; }
    if (maxQ !== null && maxQ <= 0) errors.maxMark = 'حداکثر نمره باید بزرگ‌تر از صفر باشد';
    const subject = db.prepare('SELECT id FROM subjects WHERE id = ? AND active = 1').get(input.subjectId);
    if (!subject) errors.subjectId = 'درس نامعتبر است';
    const topicIds = Array.isArray(input.topicIds) ? input.topicIds : [];
    if (topicIds.length === 0) errors.topicIds = 'حداقل یک مبحث باید انتخاب شود';
    for (const tid of topicIds) {
      const t = db.prepare('SELECT id FROM topics WHERE id = ? AND subject_id = ? AND active = 1').get(tid, input.subjectId);
      if (!t) errors.topicIds = 'مبحث باید متعلق به درس این سؤال باشد';
    }
    if (Object.keys(errors).length) throw badRequest('validation_failed', 'اطلاعات سؤال معتبر نیست', errors);

    const next = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM questions WHERE exam_id = ?').get(examId).p;
    const position = Number.isInteger(input.position) && input.position > 0 ? input.position : next;
    if (position !== next) {
      // Two-step shift through negative values avoids transient UNIQUE collisions.
      db.prepare('UPDATE questions SET position = -(position + 1) WHERE exam_id = ? AND position >= ?').run(examId, position);
      db.prepare('UPDATE questions SET position = -position WHERE exam_id = ? AND position < 0').run(examId);
    }
    const info = db.prepare(
      `INSERT INTO questions (exam_id, position, subject_id, body, max_quarters, grading_instructions, explanatory_answer)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(examId, position, subject.id, body, maxQ,
      input.gradingInstructions ? String(input.gradingInstructions).slice(0, 2000) : null,
      input.explanatoryAnswer ? String(input.explanatoryAnswer).slice(0, 5000) : null);
    const qid = Number(info.lastInsertRowid);
    for (const tid of topicIds) db.prepare('INSERT INTO question_topics (question_id, topic_id) VALUES (?, ?)').run(qid, tid);
    touchExam(db, examId, now);
    recordAudit(db, { actor, action: 'question.added', entityType: 'question', entityId: qid, details: { examId, position } }, now);
    return { id: qid, position };
  })();
}

function touchExam(db, examId, now) {
  db.prepare('UPDATE exams SET updated_at = ?, version = version + 1 WHERE id = ?').run(now.toISOString(), examId);
  const total = db.prepare('SELECT COALESCE(SUM(max_quarters), 0) AS t FROM questions WHERE exam_id = ?').get(examId).t;
  db.prepare('UPDATE exams SET total_quarters = ? WHERE id = ?').run(total, examId);
}

/**
 * Pre-publication validation. Returns a list of problems (empty = publishable).
 */
function publicationProblems(db, examId, now = new Date()) {
  const exam = getExam(db, examId);
  const problems = [];
  if (!exam.title || exam.title.trim().length < 3) problems.push({ field: 'title', message: 'عنوان آزمون' });
  const grades = db.prepare('SELECT COUNT(*) n FROM exam_grades WHERE exam_id = ?').get(examId).n;
  if (grades === 0) problems.push({ field: 'grades', message: 'حداقل یک پایه' });
  const qs = db.prepare('SELECT id, max_quarters FROM questions WHERE exam_id = ?').all(examId);
  const qFile = db.prepare('SELECT COUNT(*) n FROM exam_question_files WHERE exam_id = ?').get(examId).n;
  const qCount = db.prepare('SELECT question_count FROM exams WHERE id = ?').get(examId).question_count;

  // دو شیوه‌ی تعریف سؤالات داریم و هرکدام به‌تنهایی معتبر است:
  //   ۱) فایل واحد سؤالات + تعداد سؤالات برای تصحیح (شیوه‌ی جدید)
  //   ۲) ثبت دانه‌دانه‌ی سؤالات در جدول questions (شیوه‌ی قدیمی)
  if (qs.length === 0 && qFile === 0) {
    problems.push({ field: 'questions', message: 'فایل سؤالات یا حداقل یک سؤال' });
  } else if (qs.length === 0 && qFile > 0 && !(qCount > 0)) {
    problems.push({ field: 'question_count', message: 'تعداد سؤالات برای تصحیح (پس از آپلود فایل سؤالات) تعریف نشده' });
  }

  for (const q of qs) {
    if (!(q.max_quarters > 0)) problems.push({ field: 'question_marks', message: `نمره‌ی سؤال نامعتبر است` });
  }
  const total = qs.reduce((s, q) => s + q.max_quarters, 0);
  if (qs.length && total <= 0) problems.push({ field: 'total_marks', message: 'مجموع نمرات معتبر' });
  const sub = db.prepare('SELECT COUNT(*) n FROM answer_keys WHERE exam_id = ?').get(examId).n;
  if (sub === 0) problems.push({ field: 'answer_key', message: 'فایل پاسخنامه‌ی رسمی' });
  if (new Date(exam.submission_deadline) <= now) problems.push({ field: 'submission_deadline', message: 'مهلت ارسال گذشته است' });
  try {
    validateSchedule({
      startsAt: new Date(exam.starts_at), submissionDeadline: new Date(exam.submission_deadline),
      answerKeyPublishAt: new Date(exam.answer_key_publish_at), resultsPublishAt: new Date(exam.results_publish_at),
    });
  } catch (e) {
    problems.push({ field: 'timing', message: 'زمان‌بندی' });
  }
  return problems;
}

function transition(db, examId, to, { now = new Date(), actor = 'admin', force = false } = {}) {
  return db.transaction(() => {
    const exam = getExam(db, examId);
    if (!(TRANSITIONS[exam.status] || []).includes(to) && !force) {
      throw conflict('invalid_transition', `تغییر وضعیت از ${exam.status} به ${to} مجاز نیست`);
    }
    if (to === 'published') {
      const problems = publicationProblems(db, examId, now);
      if (problems.length) throw conflict('not_publishable', 'آزمون کامل نیست', { problems });
    }
    db.prepare('UPDATE exams SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(to, now.toISOString(), examId, exam.status);
    recordAudit(db, { actor, action: 'exam.status', entityType: 'exam', entityId: examId, details: { from: exam.status, to } }, now);
    return { id: examId, status: to };
  })();
}

/**
 * Schedule edits. Published exams stay editable, but changes are logged and
 * cannot invalidate existing submissions (for example, moving the deadline
 * into the past once submissions exist).
 */
function updateSchedule(db, examId, input, { now = new Date(), actor = 'admin' } = {}) {
  return db.transaction(() => {
    const exam = getExam(db, examId);
    if (['grading', 'results_published', 'archived'].includes(exam.status)) {
      throw conflict('exam_locked', 'زمان‌بندی در این مرحله قابل تغییر نیست');
    }
    const times = {
      startsAt: parseTime(input.startsAt ?? exam.starts_at, 'startsAt'),
      submissionDeadline: parseTime(input.submissionDeadline ?? exam.submission_deadline, 'submissionDeadline'),
      answerKeyPublishAt: parseTime(input.answerKeyPublishAt ?? exam.answer_key_publish_at, 'answerKeyPublishAt'),
      resultsPublishAt: parseTime(input.resultsPublishAt ?? exam.results_publish_at, 'resultsPublishAt'),
    };
    validateSchedule(times);
    const hasSubs = db.prepare('SELECT COUNT(*) n FROM submissions WHERE exam_id = ?').get(examId).n > 0;
    if (hasSubs && times.submissionDeadline < now) {
      throw conflict('deadline_would_invalidate', 'مهلت ارسال نمی‌تواند به گذشته منتقل شود وقتی ارسالی وجود دارد');
    }
    if (hasSubs && times.startsAt.toISOString() !== exam.starts_at) {
      throw conflict('start_locked', 'زمان شروع پس از دریافت ارسال قابل تغییر نیست');
    }
    db.prepare(
      `UPDATE exams SET starts_at = ?, submission_deadline = ?, answer_key_publish_at = ?, results_publish_at = ?,
         updated_at = ?, version = version + 1 WHERE id = ?`
    ).run(iso(times.startsAt), iso(times.submissionDeadline), iso(times.answerKeyPublishAt),
      iso(times.resultsPublishAt), now.toISOString(), examId);
    db.prepare('INSERT INTO exam_change_log (exam_id, change_type, details, actor, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(examId, 'schedule_changed', JSON.stringify({
        before: { starts_at: exam.starts_at, submission_deadline: exam.submission_deadline },
        after: { starts_at: iso(times.startsAt), submission_deadline: iso(times.submissionDeadline) },
      }), actor, now.toISOString());
    recordAudit(db, { actor, action: 'exam.schedule_changed', entityType: 'exam', entityId: examId }, now);
    return { id: examId };
  })();
}

/**
 * Record a student's answer-sheet submission. Server-authoritative:
 * - exam must be open and the start time reached,
 * - the deadline must not have passed,
 * - the student must be eligible (grade and field),
 * - one submission per student (UNIQUE); a finalized submission cannot be replaced.
 * File storage is attached by the upload layer in a later step.
 */
function recordSubmission(db, examId, studentId, { now = new Date() } = {}) {
  return db.transaction(() => {
    const exam = getExam(db, examId);
    if (!['published', 'in_progress'].includes(exam.status)) throw conflict('exam_not_open', 'آزمون باز نیست');
    if (now < new Date(exam.starts_at)) throw conflict('not_started', 'آزمون هنوز شروع نشده است');
    if (now >= new Date(exam.submission_deadline)) throw conflict('deadline_passed', 'مهلت ارسال پاسخ به پایان رسیده است');
    if (!isEligible(db, examId, studentId)) throw conflict('not_eligible', 'این آزمون برای حساب شما در دسترس نیست');
    const existing = db.prepare('SELECT id, status FROM submissions WHERE exam_id = ? AND student_id = ?').get(examId, studentId);
    if (existing) throw conflict('already_submitted', 'برای این آزمون قبلاً پاسخ ثبت شده است');
    const info = db.prepare(
      `INSERT INTO submissions (exam_id, student_id, status, submitted_at, created_at) VALUES (?, ?, 'submitted', ?, ?)`
    ).run(examId, studentId, now.toISOString(), now.toISOString());
    if (exam.status === 'published') {
      db.prepare("UPDATE exams SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'published'")
        .run(now.toISOString(), examId);
    }
    return { id: Number(info.lastInsertRowid), status: 'submitted', submittedAt: now.toISOString() };
  })();
}

function isEligible(db, examId, studentId) {
  const s = db.prepare("SELECT grade_id, field_id FROM students WHERE id = ? AND status = 'active'").get(studentId);
  if (!s) return false;
  const gradeOk = db.prepare('SELECT 1 FROM exam_grades WHERE exam_id = ? AND grade_id = ?').get(examId, s.grade_id);
  if (!gradeOk) return false;
  const fieldRestricted = db.prepare('SELECT COUNT(*) n FROM exam_fields WHERE exam_id = ?').get(examId).n > 0;
  if (!fieldRestricted) return true;
  return Boolean(db.prepare('SELECT 1 FROM exam_fields WHERE exam_id = ? AND field_id = ?').get(examId, s.field_id));
}

module.exports = {
  TRANSITIONS, createExam, addQuestion, publicationProblems, transition, updateSchedule,
  recordSubmission, isEligible, getExam, touchExam, updateExam, deleteExam, allowedUntil,
};
