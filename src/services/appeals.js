'use strict';
// Score appeals. A student may appeal a finalized official result within a
// time window after results are published. Only one open appeal per submission.
// An accepted appeal applies the corrected mark through correctScore(), so the
// change is written to score_history and the audit log.
const { badRequest, conflict, notFound } = require('./errors');
const { recordAudit } = require('./audit');
const { correctScore } = require('./grading');
const { notifyAppealDecided, queueAppealAlert } = require('./notifications');

const DEFAULT_WINDOW_DAYS = 7;

function createAppeal(db, { submissionId, studentId, questionId = null, reason }, { now = new Date(), appealWindowDays = DEFAULT_WINDOW_DAYS, adminChatId = '' } = {}) {
  return db.transaction(() => {
    const sub = db.prepare('SELECT id, exam_id, student_id, status FROM submissions WHERE id = ?').get(submissionId);
    if (!sub || sub.student_id !== studentId || sub.status !== 'submitted') throw notFound('پاسخ یافت نشد');
    const exam = db.prepare('SELECT id, title, results_published_at FROM exams WHERE id = ?').get(sub.exam_id);
    if (!exam.results_published_at) throw conflict('results_not_published', 'نتایج این آزمون هنوز منتشر نشده است');
    const deadline = new Date(exam.results_published_at).getTime() + appealWindowDays * 24 * 3600e3;
    if (now.getTime() > deadline) throw conflict('appeal_window_closed', 'مهلت اعتراض به پایان رسیده است');
    const completed = db.prepare("SELECT 1 FROM grading_assignments WHERE submission_id = ? AND state = 'completed'").get(submissionId);
    if (!completed) throw conflict('not_graded', 'این برگه هنوز نهایی نشده است');
    if (questionId !== null) {
      const q = db.prepare('SELECT id FROM questions WHERE id = ? AND exam_id = ?').get(questionId, sub.exam_id);
      if (!q) throw badRequest('invalid_question', 'سؤال نامعتبر است');
    }
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text.length < 10 || text.length > 1000) throw badRequest('validation_failed', 'متن اعتراض باید بین ۱۰ تا ۱۰۰۰ کاراکتر باشد', { reason: 'invalid' });
    let info;
    try {
      info = db.prepare(
        `INSERT INTO appeals (submission_id, student_id, question_id, reason, status, created_at)
         VALUES (?, ?, ?, ?, 'open', ?)`
      ).run(submissionId, studentId, questionId, text, now.toISOString());
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw conflict('appeal_already_open', 'برای این پاسخ اعتراض باز وجود دارد');
      throw e;
    }
    const id = Number(info.lastInsertRowid);
    recordAudit(db, { actor: `student:${studentId}`, action: 'appeal.created', entityType: 'appeal', entityId: id, details: { submissionId, questionId } }, now);
    queueAppealAlert(db, { appealId: id, examTitle: exam.title, adminChatId, now });
    return { id, status: 'open' };
  })();
}

function decideAppeal(db, appealId, { decision, note = '', questionId = null, newMark = null }, { now = new Date(), actor = 'admin' } = {}) {
  return db.transaction(() => {
    const a = db.prepare('SELECT * FROM appeals WHERE id = ?').get(appealId);
    if (!a) throw notFound('اعتراض یافت نشد');
    if (a.status !== 'open') throw conflict('appeal_closed', 'این اعتراض قبلاً بررسی شده است');
    if (!['accept', 'reject'].includes(decision)) throw badRequest('invalid_decision', 'تصمیم نامعتبر است');
    const noteText = String(note || '').trim();
    if (noteText.length < 3) throw badRequest('note_required', 'توضیح تصمیم لازم است');
    if (decision === 'accept') {
      const qid = questionId || a.question_id;
      if (!qid || newMark === null || newMark === undefined) {
        throw badRequest('correction_required', 'برای پذیرش اعتراض، سؤال و نمره‌ی اصلاح‌شده لازم است');
      }
      correctScore(db, a.submission_id, Number(qid), newMark, { reason: `اعتراض #${appealId}: ${noteText}`, now, actor });
    }
    const status = decision === 'accept' ? 'accepted' : 'rejected';
    db.prepare('UPDATE appeals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ?')
      .run(status, now.toISOString(), actor, noteText.slice(0, 1000), appealId);
    recordAudit(db, { actor, action: `appeal.${status}`, entityType: 'appeal', entityId: appealId }, now);
    const updated = db.prepare('SELECT * FROM appeals WHERE id = ?').get(appealId);
    notifyAppealDecided(db, updated, now);
    return { id: appealId, status };
  })();
}

function listAppeals(db, { status = null, limit = 200 } = {}) {
  return db.prepare(
    `SELECT a.id, a.status, a.reason, a.created_at, a.decided_at, a.decision_note, a.question_id,
            a.submission_id, a.student_id, st.full_name, e.title AS exam_title
       FROM appeals a
       JOIN submissions s ON s.id = a.submission_id
       JOIN exams e ON e.id = s.exam_id
       JOIN students st ON st.id = a.student_id
      WHERE (? IS NULL OR a.status = ?)
      ORDER BY a.id DESC LIMIT ?`
  ).all(status, status, limit);
}

function studentAppeals(db, studentId) {
  return db.prepare(
    `SELECT a.id, a.status, a.created_at, a.decided_at, a.decision_note, a.submission_id, e.title AS exam_title
       FROM appeals a JOIN submissions s ON s.id = a.submission_id JOIN exams e ON e.id = s.exam_id
      WHERE a.student_id = ? ORDER BY a.id DESC`
  ).all(studentId);
}

module.exports = { createAppeal, decideAppeal, listAppeals, studentAppeals, DEFAULT_WINDOW_DAYS };
