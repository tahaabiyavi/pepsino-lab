'use strict';
// Student in-app notifications and admin Telegram events.
// Every event has a deterministic dedupe key, so re-running the scheduler or
// retrying a job never creates a duplicate.
const { isEligible } = require('./exams');
const { enqueue } = require('./outbox');

function insertNotification(db, { studentId, kind, title, body, dedupeKey, now = new Date() }) {
  return db.prepare(
    `INSERT OR IGNORE INTO notifications (student_id, kind, title, body, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(studentId, kind, title, body, dedupeKey, now.toISOString()).changes;
}

function eligibleStudents(db, examId) {
  return db.prepare("SELECT id FROM students WHERE status = 'active'").all()
    .map((r) => r.id)
    .filter((sid) => isEligible(db, examId, sid));
}

function examTitle(db, examId) {
  const e = db.prepare('SELECT title FROM exams WHERE id = ?').get(examId);
  return e ? e.title : '';
}

function notifyExamPublished(db, examId, now = new Date()) {
  const title = examTitle(db, examId);
  let n = 0;
  for (const sid of eligibleStudents(db, examId)) {
    n += insertNotification(db, {
      studentId: sid, kind: 'exam_published', title: 'آزمون جدید منتشر شد',
      body: `آزمون «${title}» منتشر شد. پیش از مهلت پاسخنامه خود را بارگذاری کنید.`,
      dedupeKey: `exam_published:${examId}:${sid}`, now,
    });
  }
  return n;
}

function notifyAnswerKeyPublished(db, examId, now = new Date()) {
  const title = examTitle(db, examId);
  let n = 0;
  for (const sid of eligibleStudents(db, examId)) {
    n += insertNotification(db, {
      studentId: sid, kind: 'answer_key_published', title: 'پاسخنامه رسمی منتشر شد',
      body: `پاسخنامه رسمی آزمون «${title}» در دسترس است.`,
      dedupeKey: `answer_key_published:${examId}:${sid}`, now,
    });
  }
  return n;
}

function notifyResultsPublished(db, examId, now = new Date()) {
  const title = examTitle(db, examId);
  const rows = db.prepare(
    `SELECT DISTINCT s.student_id FROM submissions s
       JOIN grading_assignments a ON a.submission_id = s.id AND a.state = 'completed'
      WHERE s.exam_id = ? AND s.status = 'submitted'`
  ).all(examId);
  let n = 0;
  for (const { student_id: sid } of rows) {
    n += insertNotification(db, {
      studentId: sid, kind: 'results_published', title: 'نتایج منتشر شد',
      body: `نتایج آزمون «${title}» منتشر شد. کارنامه خود را در بخش نتایج ببینید.`,
      dedupeKey: `results_published:${examId}:${sid}`, now,
    });
  }
  return n;
}

function notifyAppealDecided(db, appeal, now = new Date()) {
  const accepted = appeal.status === 'accepted';
  return insertNotification(db, {
    studentId: appeal.student_id, kind: 'appeal_decided',
    title: accepted ? 'اعتراض شما پذیرفته شد' : 'اعتراض شما بررسی شد',
    body: accepted ? 'نمره‌ی شما بر اساس بررسی مجدد اصلاح شد.' : 'پس از بررسی، اعتراض شما پذیرفته نشد.',
    dedupeKey: `appeal_decided:${appeal.id}`, now,
  });
}

/**
 * Scheduler hook: emit notifications for events that the publication step has
 * already recorded. Safe to run on every tick.
 */
function scanPublicationEvents(db, now = new Date()) {
  let n = 0;
  for (const { id } of db.prepare('SELECT id FROM exams WHERE answer_key_published_at IS NOT NULL').all()) {
    n += notifyAnswerKeyPublished(db, id, now);
  }
  for (const { id } of db.prepare('SELECT id FROM exams WHERE results_published_at IS NOT NULL').all()) {
    n += notifyResultsPublished(db, id, now);
  }
  return n;
}

/** Admin Telegram event for a new appeal (retry-safe via dedupe_key). */
function queueAppealAlert(db, { appealId, examTitle: title, adminChatId, now = new Date() }) {
  enqueue(db, {
    dedupeKey: `appeal_new:${appealId}`,
    channel: 'telegram_admin',
    recipient: adminChatId || 'UNCONFIGURED',
    payload: { kind: 'appeal_new', appealId, examTitle: title, createdAt: now.toISOString() },
    now,
  });
}

module.exports = {
  notifyExamPublished, notifyAnswerKeyPublished, notifyResultsPublished, notifyAppealDecided,
  scanPublicationEvents, queueAppealAlert, eligibleStudents,
};
