'use strict';
// Grading assignment engine and grading workflow.
//
// Distribution: unassigned eligible answer sheets are shuffled randomly and
// each is given to the active grader with the smallest current workload
// (random tie-break). This keeps any two active graders within one sheet of each
// other, and randomness never overrides balance. Everything runs inside one
// transaction, and a submission can never hold two open assignments (partial
// unique index), so re-running the job cannot duplicate work.
const crypto = require('crypto');
const { badRequest, conflict, notFound, forbidden } = require('./errors');
const { recordAudit } = require('./audit');
const { parseMarkToQuarters, validateScoreQuarters, validateTotalQuarters, formatQuarters } = require('./marks');
const { getExam } = require('./exams');

const randomInt = (n) => crypto.randomInt(n);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createGrader(db, { displayName, icon }, { now = new Date(), actor = 'admin' } = {}) {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (name.length < 2 || name.length > 60) throw badRequest('validation_failed', 'نام نمایشی باید بین ۲ تا ۶۰ کاراکتر باشد', { displayName: 'invalid' });
  const ic = typeof icon === 'string' && icon.trim() ? icon.trim().slice(0, 8) : '🧑‍🏫';
  const info = db.prepare('INSERT INTO grader_profiles (display_name, icon, active, created_at) VALUES (?, ?, 1, ?)')
    .run(name, ic, now.toISOString());
  recordAudit(db, { actor, action: 'grader.created', entityType: 'grader', entityId: info.lastInsertRowid, details: { displayName: name } }, now);
  return { id: Number(info.lastInsertRowid), displayName: name, icon: ic, active: true };
}

/** Current open workload per active grader (state = active). */
function graderLoads(db) {
  const rows = db.prepare(
    `SELECT g.id, COUNT(a.id) AS load
       FROM grader_profiles g
       LEFT JOIN grading_assignments a ON a.grader_id = g.id AND a.state = 'active'
      WHERE g.active = 1
      GROUP BY g.id`
  ).all();
  return rows.map((r) => ({ id: r.id, load: r.load }));
}

/** Place submissions onto the least-loaded graders. Returns the created assignments. */
function placeOnLeastLoaded(db, submissionIds, batchId, now) {
  const loads = graderLoads(db);
  if (loads.length === 0) throw conflict('no_active_graders', 'هیچ ادمین تصحیح‌کننده‌ی فعالی وجود ندارد');
  const ordered = shuffle(submissionIds);
  const created = [];
  for (const sid of ordered) {
    // Smallest load; random tie-break so the sheets are not dealt in a fixed order.
    for (const l of loads) l.tie = randomInt(1e9);   // fresh random tie-break per placement
    loads.sort((a, b) => a.load - b.load || a.tie - b.tie);
    const target = loads[0];
    db.prepare(
      `INSERT INTO grading_assignments (submission_id, grader_id, batch_id, state, assigned_at)
       VALUES (?, ?, ?, 'active', ?)`
    ).run(sid, target.id, batchId, now.toISOString());
    target.load += 1;
    created.push({ submissionId: sid, graderId: target.id });
  }
  return created;
}

/**
 * Distribute all unassigned eligible answer sheets for an exam.
 * Idempotent: a second run finds nothing unassigned and creates nothing.
 */
function distributeExam(db, examId, { now = new Date(), kind = 'initial', actor = 'system' } = {}) {
  return db.transaction(() => {
    const unassigned = db.prepare(
      `SELECT s.id FROM submissions s
        WHERE s.exam_id = ? AND s.status = 'submitted'
          AND NOT EXISTS (SELECT 1 FROM grading_assignments a
                           WHERE a.submission_id = s.id AND a.state IN ('active','completed'))
        ORDER BY s.id`
    ).all(examId).map((r) => r.id);
    if (unassigned.length === 0) return { created: 0, batchId: null, assignments: [] };

    const batchId = Number(db.prepare(
      'INSERT INTO grading_batches (exam_id, kind, created_at, note) VALUES (?, ?, ?, ?)'
    ).run(examId, kind, now.toISOString(), `${unassigned.length} sheets`).lastInsertRowid);
    const assignments = placeOnLeastLoaded(db, unassigned, batchId, now);
    recordAudit(db, { actor, action: 'grading.distributed', entityType: 'exam', entityId: examId,
      details: { batchId, count: assignments.length, graders: summarize(assignments) } }, now);
    return { created: assignments.length, batchId, assignments };
  })();
}

function summarize(assignments) {
  const m = {};
  for (const a of assignments) m[a.graderId] = (m[a.graderId] || 0) + 1;
  return m;
}

/**
 * Deactivate a grader. Their open (state=active) sheets are reassigned to active
 * graders. Completed grading is never touched.
 */
function deactivateGrader(db, graderId, { now = new Date(), actor = 'admin', reason = 'deactivated' } = {}) {
  return db.transaction(() => {
    const g = db.prepare('SELECT id FROM grader_profiles WHERE id = ?').get(graderId);
    if (!g) throw notFound('تصحیح‌کننده یافت نشد');
    db.prepare('UPDATE grader_profiles SET active = 0 WHERE id = ?').run(graderId);
    const moved = reassignOpenWork(db, { graderId, now, actor, reason });
    recordAudit(db, { actor, action: 'grader.deactivated', entityType: 'grader', entityId: graderId, details: { reassigned: moved.count } }, now);
    return moved;
  })();
}

function reassignOpenWork(db, { graderId, now, actor, reason }) {
  const open = db.prepare(
    `SELECT id, submission_id FROM grading_assignments WHERE grader_id = ? AND state = 'active' ORDER BY id`
  ).all(graderId);
  if (open.length === 0) return { count: 0, moved: [] };
  const batchId = Number(db.prepare(
    `INSERT INTO grading_batches (exam_id, kind, created_at, note)
     SELECT s.exam_id, 'reassignment', ?, ? FROM submissions s WHERE s.id = ?`
  ).run(now.toISOString(), `reassigned from grader ${graderId}`, open[0].submission_id).lastInsertRowid);
  for (const a of open) {
    db.prepare(`UPDATE grading_assignments SET state = 'reassigned', reassigned_at = ?, reassign_reason = ? WHERE id = ?`)
      .run(now.toISOString(), reason, a.id);
  }
  // Do not carry partial scores over. The old rows stay as history.
  const subs = open.map((a) => a.submission_id);
  const placed = placeOnLeastLoaded(db, subs, batchId, now);
  return { count: placed.length, moved: placed };
}

/** Admin override: move one open sheet to a specific grader. */
function reassignSubmission(db, submissionId, toGraderId, { now = new Date(), actor = 'admin', reason = 'manual' } = {}) {
  return db.transaction(() => {
    const open = db.prepare(`SELECT * FROM grading_assignments WHERE submission_id = ? AND state = 'active'`).get(submissionId);
    if (!open) throw conflict('no_open_assignment', 'برگه‌ی باز برای تخصیص مجدد وجود ندارد (ممکن است تصحیح شده باشد)');
    const target = db.prepare('SELECT id FROM grader_profiles WHERE id = ? AND active = 1').get(toGraderId);
    if (!target) throw conflict('grader_inactive', 'تصحیح‌کننده‌ی مقصد فعال نیست');
    const sub = db.prepare('SELECT exam_id FROM submissions WHERE id = ?').get(submissionId);
    const batchId = Number(db.prepare('INSERT INTO grading_batches (exam_id, kind, created_at, note) VALUES (?, ?, ?, ?)')
      .run(sub.exam_id, 'manual', now.toISOString(), reason).lastInsertRowid);
    db.prepare(`UPDATE grading_assignments SET state = 'reassigned', reassigned_at = ?, reassign_reason = ? WHERE id = ?`)
      .run(now.toISOString(), reason, open.id);
    const info = db.prepare(`INSERT INTO grading_assignments (submission_id, grader_id, batch_id, state, assigned_at)
      VALUES (?, ?, ?, 'active', ?)`).run(submissionId, toGraderId, batchId, now.toISOString());
    recordAudit(db, { actor, action: 'grading.reassigned', entityType: 'submission', entityId: submissionId,
      details: { from: open.grader_id, to: toGraderId, reason } }, now);
    return { assignmentId: Number(info.lastInsertRowid) };
  })();
}

function getAssignmentForGrader(db, assignmentId, graderId) {
  const a = db.prepare('SELECT * FROM grading_assignments WHERE id = ?').get(assignmentId);
  if (!a) throw notFound('برگه یافت نشد');
  // Graders see only their own assignments. Admin access uses the admin path.
  if (a.grader_id !== graderId) throw forbidden('این برگه به شما تخصیص داده نشده است');
  return a;
}

/**
 * Save scores for one assignment (draft; autosave-friendly).
 * scores: [{ questionId, mark: "0.75" | number }]. Each value is validated.
 */
function saveScores(db, assignmentId, graderId, { scores = [], comments = {}, overallComment } = {}, { now = new Date() } = {}) {
  return db.transaction(() => {
    const a = getAssignmentForGrader(db, assignmentId, graderId);
    if (a.state !== 'active') throw conflict('assignment_closed', 'این برگه دیگر قابل ویرایش نیست');
    const sub = db.prepare('SELECT exam_id FROM submissions WHERE id = ?').get(a.submission_id);
    const exam = getExam(db, sub.exam_id);
    if (exam.status !== 'grading') throw conflict('not_grading', 'تصحیح در این مرحله فعال نیست');

    const questions = new Map(db.prepare('SELECT id, max_quarters FROM questions WHERE exam_id = ?').all(sub.exam_id).map((q) => [q.id, q]));
    const errors = [];
    const parsed = [];
    for (const s of scores) {
      const q = questions.get(Number(s.questionId));
      if (!q) { errors.push({ questionId: s.questionId, code: 'unknown_question' }); continue; }
      try {
        const quarters = validateScoreQuarters(parseMarkToQuarters(s.mark), q.max_quarters);
        parsed.push({ questionId: q.id, quarters, comment: comments[q.id] ? String(comments[q.id]).slice(0, 2000) : null });
      } catch (e) {
        errors.push({ questionId: q.id, code: e.code, message: e.message });
      }
    }
    if (errors.length) throw badRequest('invalid_scores', 'بعضی نمره‌ها معتبر نیستند', { errors });

    const up = db.prepare(
      `INSERT INTO question_scores (assignment_id, question_id, quarters, comment, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(assignment_id, question_id) DO UPDATE SET
         quarters = excluded.quarters, comment = COALESCE(excluded.comment, question_scores.comment), updated_at = excluded.updated_at`
    );
    for (const p of parsed) up.run(assignmentId, p.questionId, p.quarters, p.comment, now.toISOString());
    // بررسی مجموع نمرات: نباید از ۲۰ بیشتر شود
    const sumRow = db.prepare('SELECT COALESCE(SUM(quarters), 0) AS t FROM question_scores WHERE assignment_id = ?').get(assignmentId);
    validateTotalQuarters(sumRow.t);
    if (overallComment !== undefined) {
      db.prepare('UPDATE grading_assignments SET overall_comment = ? WHERE id = ?')
        .run(overallComment ? String(overallComment).slice(0, 3000) : null, assignmentId);
    }
    const saved = db.prepare('SELECT COUNT(*) n FROM question_scores WHERE assignment_id = ?').get(assignmentId).n;
    const total = questions.size;
    return { saved: parsed.length, progress: { scored: saved, total }, complete: saved === total, totalMark: require('./marks').formatQuarters(sumRow.t) };
  })();
}

/** Finalize a grading record. Requires every question to be scored. */
function finalizeAssignment(db, assignmentId, graderId, { now = new Date() } = {}) {
  return db.transaction(() => {
    const a = getAssignmentForGrader(db, assignmentId, graderId);
    if (a.state !== 'active') throw conflict('assignment_closed', 'این برگه قبلاً نهایی شده است');
    const sub = db.prepare('SELECT exam_id FROM submissions WHERE id = ?').get(a.submission_id);
    const missing = db.prepare(
      `SELECT q.id, q.position FROM questions q
        WHERE q.exam_id = ? AND NOT EXISTS (SELECT 1 FROM question_scores s WHERE s.assignment_id = ? AND s.question_id = q.id)
        ORDER BY q.position`
    ).all(sub.exam_id, assignmentId);
    if (missing.length) throw conflict('grading_incomplete', 'نمره‌ی بعضی سؤال‌ها ثبت نشده است', { missingQuestions: missing });
    // مجموع نباید از ۲۰ بیشتر باشد
    const sumRow = db.prepare('SELECT COALESCE(SUM(quarters), 0) AS t FROM question_scores WHERE assignment_id = ?').get(assignmentId);
    validateTotalQuarters(sumRow.t);
    db.prepare(`UPDATE grading_assignments SET state = 'completed', completed_at = ? WHERE id = ?`).run(now.toISOString(), assignmentId);
    db.prepare('UPDATE submissions SET finalized_at = ? WHERE id = ?').run(now.toISOString(), a.submission_id);
    recordAudit(db, { actor: `grader:${graderId}`, action: 'grading.finalized', entityType: 'submission', entityId: a.submission_id }, now);
    return { state: 'completed', totalQuarters: submissionTotalQuarters(db, a.submission_id) };
  })();
}

/** Current total for a submission in quarters (from the completed assignment), or null. */
function submissionTotalQuarters(db, submissionId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(qs.quarters), 0) AS total
       FROM grading_assignments a
       JOIN question_scores qs ON qs.assignment_id = a.id
      WHERE a.submission_id = ? AND a.state = 'completed'`
  ).get(submissionId);
  const completed = db.prepare(`SELECT 1 FROM grading_assignments WHERE submission_id = ? AND state = 'completed'`).get(submissionId);
  return completed ? row.total : null;
}

/**
 * Admin correction of an already-graded question. Keeps the history.
 * Corrections are allowed only on completed grading.
 */
function correctScore(db, submissionId, questionId, mark, { reason, now = new Date(), actor = 'admin' } = {}) {
  return db.transaction(() => {
    if (!reason || String(reason).trim().length < 3) throw badRequest('reason_required', 'دلیل اصلاح نمره را وارد کنید');
    const a = db.prepare(`SELECT * FROM grading_assignments WHERE submission_id = ? AND state = 'completed'`).get(submissionId);
    if (!a) throw conflict('not_graded', 'این برگه هنوز تصحیح نهایی نشده است');
    const sub = db.prepare('SELECT exam_id FROM submissions WHERE id = ?').get(submissionId);
    const q = db.prepare('SELECT id, max_quarters FROM questions WHERE id = ? AND exam_id = ?').get(questionId, sub.exam_id);
    if (!q) throw notFound('سؤال یافت نشد');
    const newQ = validateScoreQuarters(parseMarkToQuarters(mark), q.max_quarters);
    const prev = db.prepare('SELECT quarters FROM question_scores WHERE assignment_id = ? AND question_id = ?').get(a.id, questionId);
    const previous = prev ? prev.quarters : null;
    if (previous === newQ) return { changed: false, quarters: newQ };
    db.prepare(`INSERT INTO question_scores (assignment_id, question_id, quarters, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(assignment_id, question_id) DO UPDATE SET quarters = excluded.quarters, updated_at = excluded.updated_at`)
      .run(a.id, questionId, newQ, now.toISOString());
    db.prepare(`INSERT INTO score_history (submission_id, question_id, previous_quarters, new_quarters, reason, actor, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(submissionId, questionId, previous, newQ, String(reason).slice(0, 500), actor, now.toISOString());
    recordAudit(db, { actor, action: 'score.corrected', entityType: 'submission', entityId: submissionId,
      details: { questionId, previous: previous === null ? null : formatQuarters(previous), next: formatQuarters(newQ), reason: String(reason).slice(0, 200) } }, now);
    return { changed: true, previous, quarters: newQ, total: submissionTotalQuarters(db, submissionId) };
  })();
}

/** Mark a student absent for an exam (separate from a zero score). */
function markAbsent(db, examId, studentId, { now = new Date(), actor = 'admin' } = {}) {
  return db.transaction(() => {
    getExam(db, examId);
    const existing = db.prepare('SELECT id, status FROM submissions WHERE exam_id = ? AND student_id = ?').get(examId, studentId);
    if (existing && existing.status === 'submitted') throw conflict('has_submission', 'این دانش‌آموز پاسخ ارسال کرده است و نمی‌تواند غایب ثبت شود');
    if (existing) {
      db.prepare(`UPDATE submissions SET status = 'absent' WHERE id = ?`).run(existing.id);
    } else {
      db.prepare(`INSERT INTO submissions (exam_id, student_id, status, created_at) VALUES (?, ?, 'absent', ?)`)
        .run(examId, studentId, now.toISOString());
    }
    recordAudit(db, { actor, action: 'submission.marked_absent', entityType: 'exam', entityId: examId, details: { studentId } }, now);
    return { status: 'absent' };
  })();
}

/** Used when the submission window closes: non-submitters get status 'absent' automatically. */
function recordMissingForEligible(db, examId, eligibleStudentIds, { now = new Date() } = {}) {
  let n = 0;
  for (const sid of eligibleStudentIds) {
    const r = db.prepare(
      `INSERT OR IGNORE INTO submissions (exam_id, student_id, status, created_at) VALUES (?, ?, 'absent', ?)`
    ).run(examId, sid, now.toISOString());
    n += r.changes;
  }
  return n;
}

module.exports = {
  createGrader, distributeExam, deactivateGrader, reassignSubmission, saveScores, finalizeAssignment,
  correctScore, markAbsent, recordMissingForEligible, submissionTotalQuarters, graderLoads, getAssignmentForGrader,
};
