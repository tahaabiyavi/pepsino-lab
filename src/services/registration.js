'use strict';
// Registration workflow:
//   submit  -> pending request (no account yet) + admin notification (outbox)
//   accept  -> account activated, request 'accepted'   (idempotent)
//   reject  -> request 'rejected', student may resubmit (idempotent)
// Every state change happens in one SQLite transaction. Telegram delivery
// is never part of these transactions.
const { hashPassword } = require('../auth/passwords');
const { validateRegistrationInput } = require('./validation');
const { AppError, badRequest, conflict, notFound } = require('./errors');
const { recordAudit } = require('./audit');
const { enqueue } = require('./outbox');

function submitRegistration(db, rawInput, { now = new Date(), rounds = 12, adminChatId = '' } = {}) {
  const input = validateRegistrationInput(rawInput);
  const nowIso = now.toISOString();

  return db.transaction(() => {
    const grade = db.prepare('SELECT id, label FROM grades WHERE code = ? AND active = 1').get(input.gradeCode);
    const field = db.prepare('SELECT id, label FROM academic_fields WHERE code = ? AND active = 1').get(input.fieldCode);
    if (!grade) throw badRequest('validation_failed', 'پایه تحصیلی نامعتبر است', { gradeCode: 'invalid' });
    if (!field) throw badRequest('validation_failed', 'رشته تحصیلی نامعتبر است', { fieldCode: 'invalid' });

    if (db.prepare('SELECT 1 FROM students WHERE username = ? COLLATE NOCASE').get(input.username)) {
      throw conflict('username_taken', 'این نام کاربری قبلاً ثبت شده است');
    }
    if (db.prepare("SELECT 1 FROM registration_requests WHERE username = ? COLLATE NOCASE AND status = 'pending'").get(input.username)) {
      throw conflict('registration_pending', 'درخواست ثبت‌نام با این نام کاربری در انتظار تأیید است');
    }

    const passwordHash = hashPassword(input.password, rounds);
    const info = db.prepare(
      `INSERT INTO registration_requests
         (username, password_hash, full_name, grade_id, field_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(input.username, passwordHash, input.fullName, grade.id, field.id, nowIso);
    const requestId = Number(info.lastInsertRowid);

    // Admin notification is queued, never sent inline. The row is never
    // lost even if Telegram is down.
    enqueue(db, {
      dedupeKey: `registration:new:${requestId}`,
      channel: 'telegram_admin',
      recipient: adminChatId || 'UNCONFIGURED',
      payload: {
        kind: 'registration_new',
        requestId,
        fullName: input.fullName,
        username: input.username,
        grade: grade.label,
        field: field.label,
        submittedAt: nowIso,
      },
      now,
    });

    recordAudit(db, {
      actor: 'public',
      action: 'registration.submitted',
      entityType: 'registration_request',
      entityId: requestId,
      details: { username: input.username, gradeCode: input.gradeCode, fieldCode: input.fieldCode },
    }, now);

    return { id: requestId, status: 'pending', username: input.username };
  })();
}

/**
 * Accept or reject a pending registration. Idempotent:
 *  - same decision already applied  -> { changed:false, alreadyApplied:true }
 *  - opposite decision already made -> 409 already_decided
 * @param {object} p
 * @param {'accept'|'reject'} p.action
 * @param {string} p.actor  e.g. 'telegram:123' or 'admin' (web)
 * @param {'telegram'|'web'} p.source
 */
function decideRegistration(db, { requestId, action, actor, source }, { now = new Date() } = {}) {
  if (!['accept', 'reject'].includes(action)) throw badRequest('invalid_action', 'عملیات نامعتبر است');
  const nowIso = now.toISOString();
  const targetStatus = action === 'accept' ? 'accepted' : 'rejected';

  return db.transaction(() => {
    const req = db.prepare('SELECT * FROM registration_requests WHERE id = ?').get(requestId);
    if (!req) throw notFound('درخواست ثبت‌نام یافت نشد');

    if (req.status !== 'pending') {
      if (req.status === targetStatus) {
        return { changed: false, alreadyApplied: true, status: req.status, studentId: req.student_id };
      }
      throw conflict('already_decided', `این درخواست قبلاً ${req.status === 'accepted' ? 'تأیید' : 'رد'} شده است`);
    }

    let studentId = null;
    if (action === 'accept') {
      const taken = db.prepare('SELECT 1 FROM students WHERE username = ? COLLATE NOCASE').get(req.username);
      if (taken) {
        // Keep the request pending for manual resolution; never overwrite an account.
        throw conflict('username_taken', 'نام کاربری در حال حاضر متعلق به حساب دیگری است');
      }
      const info = db.prepare(
        `INSERT INTO students
           (username, password_hash, full_name, grade_id, field_id, status, created_at, updated_at, approved_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      ).run(req.username, req.password_hash, req.full_name, req.grade_id, req.field_id, nowIso, nowIso, nowIso);
      studentId = Number(info.lastInsertRowid);
    }

    // Guarded update: only succeeds while still pending.
    const upd = db.prepare(
      `UPDATE registration_requests
          SET status = ?, student_id = ?, password_hash = NULL,
              decided_at = ?, decided_by = ?, decision_source = ?
        WHERE id = ? AND status = 'pending'`
    ).run(targetStatus, studentId, nowIso, actor, source, requestId);
    if (upd.changes !== 1) throw conflict('concurrent_decision', 'درخواست هم‌زمان تغییر کرده است؛ دوباره تلاش کنید');

    recordAudit(db, {
      actor,
      action: action === 'accept' ? 'registration.accepted' : 'registration.rejected',
      entityType: 'registration_request',
      entityId: requestId,
      details: { username: req.username, source, studentId },
    }, now);

    return { changed: true, alreadyApplied: false, status: targetStatus, studentId };
  })();
}

function listRegistrations(db, { status = null, limit = 200 } = {}) {
  const where = status ? 'WHERE r.status = ?' : '';
  const args = status ? [status, limit] : [limit];
  return db.prepare(
    `SELECT r.id, r.username, r.full_name, r.status, r.created_at, r.decided_at, r.decided_by,
            g.label AS grade, f.label AS field, r.student_id
       FROM registration_requests r
       JOIN grades g ON g.id = r.grade_id
       JOIN academic_fields f ON f.id = r.field_id
       ${where}
       ORDER BY r.created_at DESC LIMIT ?`
  ).all(...args);
}

module.exports = { submitRegistration, decideRegistration, listRegistrations, AppError };
