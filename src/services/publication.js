'use strict';
// Scheduled publication. Every step is a state check inside a transaction, so
// running the scheduler repeatedly, or after downtime, is safe. Overdue work is
// processed on the next tick. Nothing is kept only in memory.
const { recordAudit } = require('./audit');
const { recordMissingForEligible, distributeExam } = require('./grading');
const { scanPublicationEvents } = require('./notifications');
const storage = require('../files/storage');

function eligibleStudentIds(db, examId) {
  const fieldRestricted = db.prepare('SELECT COUNT(*) n FROM exam_fields WHERE exam_id = ?').get(examId).n > 0;
  const sql = `SELECT s.id FROM students s
                JOIN exam_grades eg ON eg.exam_id = ? AND eg.grade_id = s.grade_id
                WHERE s.status = 'active'
                  ${fieldRestricted ? 'AND s.field_id IN (SELECT field_id FROM exam_fields WHERE exam_id = ?)' : ''}`;
  const rows = fieldRestricted ? db.prepare(sql).all(examId, examId) : db.prepare(sql).all(examId);
  return rows.map((r) => r.id);
}

/**
 * Close submission windows whose deadline has passed:
 * submitted -> stays; eligible non-submitters -> 'absent' (excluded from grading
 * and rankings — they get no mark at all, which is different from a zero);
 * then distribute the answer sheets to active graders.
 */
function closeDueWindows(db, now = new Date()) {
  const due = db.prepare(
    `SELECT id FROM exams WHERE status IN ('published','in_progress') AND submission_deadline <= ?`
  ).all(now.toISOString());
  const closed = [];
  for (const { id } of due) {
    db.transaction(() => {
      // Re-check inside the transaction (another tick may have won the race).
      const e = db.prepare('SELECT status FROM exams WHERE id = ?').get(id);
      if (!['published', 'in_progress'].includes(e.status)) return;
      db.prepare("UPDATE exams SET status = 'submission_closed', updated_at = ? WHERE id = ?").run(now.toISOString(), id);
      recordMissingForEligible(db, id, eligibleStudentIds(db, id), { now });
      db.prepare("UPDATE exams SET status = 'grading', updated_at = ? WHERE id = ?").run(now.toISOString(), id);
      recordAudit(db, { actor: 'scheduler', action: 'exam.window_closed', entityType: 'exam', entityId: id }, now);
      closed.push(id);
    })();
    if (closed.includes(id)) distributeExam(db, id, { now, kind: 'initial', actor: 'scheduler' });
  }
  return closed;
}

/** Publish the answer key once its scheduled time has arrived (only after the window closed). */
function publishDueAnswerKeys(db, now = new Date()) {
  const rows = db.prepare(
    `SELECT e.id FROM exams e JOIN answer_keys k ON k.exam_id = e.id
      WHERE e.answer_key_published_at IS NULL AND e.answer_key_publish_at <= ?
        AND e.status IN ('submission_closed','grading','results_published','archived')`
  ).all(now.toISOString());
  const done = [];
  for (const { id } of rows) {
    const r = db.prepare('UPDATE exams SET answer_key_published_at = ? WHERE id = ? AND answer_key_published_at IS NULL')
      .run(now.toISOString(), id);
    if (r.changes === 1) {
      recordAudit(db, { actor: 'scheduler', action: 'answer_key.published', entityType: 'exam', entityId: id }, now);
      done.push(id);
    }
  }
  return done;
}

/** Results are published only when the schedule has arrived AND all graded sheets are complete. */
function publishDueResults(db, now = new Date()) {
  const rows = db.prepare(
    `SELECT id FROM exams WHERE status = 'grading' AND results_publish_at <= ? AND results_published_at IS NULL`
  ).all(now.toISOString());
  const done = [];
  for (const { id } of rows) {
    const incomplete = db.prepare(
      `SELECT COUNT(*) n FROM submissions s
        WHERE s.exam_id = ? AND s.status = 'submitted'
          AND NOT EXISTS (SELECT 1 FROM grading_assignments a WHERE a.submission_id = s.id AND a.state = 'completed')`
    ).get(id).n;
    if (incomplete > 0) continue; // stays unpublished until grading completes; checked again next tick
    db.transaction(() => {
      const r = db.prepare(
        `UPDATE exams SET status = 'results_published', results_published_at = ?, updated_at = ?
          WHERE id = ? AND status = 'grading' AND results_published_at IS NULL`
      ).run(now.toISOString(), now.toISOString(), id);
      if (r.changes === 1) {
        recordAudit(db, { actor: 'scheduler', action: 'results.published', entityType: 'exam', entityId: id }, now);
        done.push(id);
      }
    })();
  }
  return done;
}

/** Results also publish when grading completes after the scheduled time (called after finalize). */
function tick(db, now = new Date(), { dataDir = null } = {}) {
  const closed = closeDueWindows(db, now);
  const keys = publishDueAnswerKeys(db, now);
  const results = publishDueResults(db, now);
  const notified = scanPublicationEvents(db, now);
  const cleaned = dataDir ? cleanupExpiredPending(db, now, dataDir) : 0;
  return { closed, answerKeys: keys, results, notified, cleanedUploads: cleaned };
}

/** Remove pending uploads whose submission window has ended: rows first, then the files. */
function cleanupExpiredPending(db, now, dataDir) {
  const rows = db.prepare('SELECT id, storage_name FROM pending_uploads WHERE expires_at <= ?').all(now.toISOString());
  for (const r of rows) {
    db.prepare('DELETE FROM pending_uploads WHERE id = ?').run(r.id);
    storage.removePrivate(dataDir, r.storage_name);
  }
  if (rows.length) recordAudit(db, { actor: 'scheduler', action: 'uploads.expired_cleaned', details: { count: rows.length } }, now);
  return rows.length;
}

module.exports = { tick, cleanupExpiredPending, closeDueWindows, publishDueAnswerKeys, publishDueResults, eligibleStudentIds };
