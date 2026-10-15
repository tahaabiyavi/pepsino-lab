'use strict';
// Account management for grader logins, student profile edits, and secure
// password reset. Passwords and tokens are never stored or logged in plaintext,
// and no endpoint can reveal an existing password.
const crypto = require('crypto');
const { hashPassword, verifyPassword, checkPasswordPolicy } = require('../auth/passwords');
const { hashToken, revokeStudentSessions } = require('../auth/sessions');
const { AppError, badRequest, conflict, notFound } = require('./errors');
const { recordAudit } = require('./audit');
const { normalizeUsername, USERNAME_RE } = require('./validation');
const { enqueue } = require('./outbox');

const RESET_TTL_MS = 24 * 3600 * 1000;

function usernameTaken(db, username) {
  return Boolean(
    db.prepare('SELECT 1 FROM students WHERE username = ? COLLATE NOCASE').get(username) ||
    db.prepare('SELECT 1 FROM grader_profiles WHERE username = ?').get(username) ||
    db.prepare('SELECT 1 FROM admin_account WHERE username = ?').get(username)
  );
}

function assertUsernameFormat(username) {
  if (!USERNAME_RE.test(username)) throw badRequest('validation_failed', 'نام کاربری نامعتبر است', { username: 'invalid' });
  if (['admin', 'root', 'support', 'telegram', 'pepsino'].includes(username)) {
    throw badRequest('validation_failed', 'این نام کاربری رزرو شده است', { username: 'reserved' });
  }
}

/** Create a grader profile with its own login. Grader accounts have no admin privileges. */
function createGraderAccount(db, input, { now = new Date(), rounds = 12, actor = 'admin' } = {}) {
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  const username = normalizeUsername(input.username);
  const errors = {};
  if (displayName.length < 2 || displayName.length > 60) errors.displayName = 'نام نمایشی باید بین ۲ تا ۶۰ کاراکتر باشد';
  try { assertUsernameFormat(username); } catch (e) { errors.username = e.details.username; }
  const pwErr = checkPasswordPolicy(input.password);
  if (pwErr) errors.password = pwErr;
  const icon = typeof input.icon === 'string' && input.icon.trim() ? input.icon.trim().slice(0, 8) : '🧑‍🏫';
  if (Object.keys(errors).length) throw badRequest('validation_failed', 'اطلاعات تصحیح‌کننده معتبر نیست', errors);

  return db.transaction(() => {
    if (usernameTaken(db, username)) throw conflict('username_taken', 'این نام کاربری قبلاً استفاده شده است');
    const info = db.prepare(
      `INSERT INTO grader_profiles (display_name, icon, active, created_at, username, password_hash)
       VALUES (?, ?, 1, ?, ?, ?)`
    ).run(displayName, icon, now.toISOString(), username, hashPassword(input.password, rounds));
    const id = Number(info.lastInsertRowid);
    recordAudit(db, { actor, action: 'grader.created', entityType: 'grader', entityId: id, details: { displayName, username } }, now);
    return { id, displayName, icon, username, active: true };
  })();
}

function setGraderActive(db, graderId, active, { now = new Date(), actor = 'admin' } = {}) {
  const g = db.prepare('SELECT id, active FROM grader_profiles WHERE id = ?').get(graderId);
  if (!g) throw notFound('تصحیح‌کننده یافت نشد');
  db.prepare('UPDATE grader_profiles SET active = ? WHERE id = ?').run(active ? 1 : 0, graderId);
  if (!active) db.prepare("DELETE FROM sessions WHERE subject_type = 'grader' AND subject_id = ?").run(graderId);
  recordAudit(db, { actor, action: active ? 'grader.reactivated' : 'grader.deactivated', entityType: 'grader', entityId: graderId }, now);
}

function updateStudent(db, studentId, input, { now = new Date(), actor = 'admin' } = {}) {
  return db.transaction(() => {
    const s = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    if (!s) throw notFound('دانش‌آموز یافت نشد');
    const fullName = input.fullName !== undefined ? String(input.fullName).trim().replace(/\s+/g, ' ') : s.full_name;
    if (fullName.length < 3 || fullName.length > 100 || /[<>{}\[\]\\]/.test(fullName)) {
      throw badRequest('validation_failed', 'نام نامعتبر است', { fullName: 'invalid' });
    }
    let gradeId = s.grade_id, fieldId = s.field_id;
    if (input.gradeCode !== undefined) {
      const g = db.prepare('SELECT id FROM grades WHERE code = ? AND active = 1').get(String(input.gradeCode));
      if (!g) throw badRequest('validation_failed', 'پایه نامعتبر است', { gradeCode: 'invalid' });
      gradeId = g.id;
    }
    if (input.fieldCode !== undefined) {
      const f = db.prepare('SELECT id FROM academic_fields WHERE code = ? AND active = 1').get(String(input.fieldCode));
      if (!f) throw badRequest('validation_failed', 'رشته نامعتبر است', { fieldCode: 'invalid' });
      fieldId = f.id;
    }
    db.prepare('UPDATE students SET full_name = ?, grade_id = ?, field_id = ?, updated_at = ? WHERE id = ?')
      .run(fullName, gradeId, fieldId, now.toISOString(), studentId);
    recordAudit(db, { actor, action: 'student.updated', entityType: 'student', entityId: studentId,
      details: { before: { full_name: s.full_name, grade_id: s.grade_id, field_id: s.field_id }, after: { full_name: fullName, grade_id: gradeId, field_id: fieldId } } }, now);
    return { id: studentId };
  })();
}

/**
 * Admin issues a one-time reset token. The token is returned ONCE to the
 * administrator, who passes it to the account owner. Only its hash is stored.
 * Earlier unused tokens for the same account are invalidated.
 */
function issuePasswordReset(db, subjectType, subjectId, { now = new Date(), actor = 'admin' } = {}) {
  return db.transaction(() => {
    const table = subjectType === 'student' ? 'students' : 'grader_profiles';
    const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(subjectId);
    if (!row) throw notFound('حساب یافت نشد');
    db.prepare('UPDATE password_resets SET used_at = ? WHERE subject_type = ? AND subject_id = ? AND used_at IS NULL')
      .run(now.toISOString(), subjectType, subjectId);
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare(`INSERT INTO password_resets (subject_type, subject_id, token_hash, created_by, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(subjectType, subjectId, hashToken(token), actor, now.toISOString(), new Date(now.getTime() + RESET_TTL_MS).toISOString());
    recordAudit(db, { actor, action: 'password.reset_issued', entityType: subjectType, entityId: subjectId }, now);
    return { token, expiresAt: new Date(now.getTime() + RESET_TTL_MS).toISOString() };
  })();
}

/** Consume a reset token: set a new password and revoke the account's sessions. */
function consumePasswordReset(db, { username, token, newPassword }, { now = new Date(), rounds = 12 } = {}) {
  const uname = normalizeUsername(username);
  const bad = () => new AppError(400, 'invalid_or_expired_token', 'کد بازیابی نامعتبر یا منقضی است');
  if (typeof token !== 'string' || token.length < 10 || token.length > 100) throw bad();
  const pwErr = checkPasswordPolicy(newPassword);
  if (pwErr) throw badRequest('validation_failed', pwErr, { password: pwErr });

  return db.transaction(() => {
    const r = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hashToken(token));
    if (!r || r.used_at || new Date(r.expires_at) <= now) throw bad();
    const hash = hashPassword(newPassword, rounds);
    if (r.subject_type === 'student') {
      const s = db.prepare('SELECT id, username FROM students WHERE id = ?').get(r.subject_id);
      if (!s || s.username.toLowerCase() !== uname) throw bad();
      db.prepare('UPDATE students SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now.toISOString(), s.id);
      revokeStudentSessions(db, s.id);
    } else {
      const g = db.prepare('SELECT id, username FROM grader_profiles WHERE id = ?').get(r.subject_id);
      if (!g || g.username !== uname) throw bad();
      db.prepare('UPDATE grader_profiles SET password_hash = ? WHERE id = ?').run(hash, g.id);
      db.prepare("DELETE FROM sessions WHERE subject_type = 'grader' AND subject_id = ?").run(g.id);
    }
    db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now.toISOString(), r.id);
    recordAudit(db, { actor: 'public', action: 'password.reset_completed', entityType: r.subject_type, entityId: r.subject_id }, now);
    return { ok: true };
  })();
}

/**
 * Student asks for help. Recorded and queued as an admin notification; the
 * response is identical whether or not the username exists (no enumeration).
 */
function requestPasswordHelp(db, username, { now = new Date(), adminChatId = '' } = {}) {
  const uname = normalizeUsername(username);
  return db.transaction(() => {
    const s = db.prepare('SELECT id FROM students WHERE username = ? COLLATE NOCASE').get(uname);
    if (s) {
      const recent = db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'password.help_requested'
                                  AND entity_id = ? AND created_at > ?`).get(String(s.id), new Date(now.getTime() - 3600e3).toISOString()).n;
      if (recent === 0) {
        recordAudit(db, { actor: 'public', action: 'password.help_requested', entityType: 'student', entityId: s.id }, now);
        enqueue(db, {
          dedupeKey: `password-help:${s.id}:${Math.floor(now.getTime() / 3600e3)}`,
          channel: 'telegram_admin',
          recipient: adminChatId || 'UNCONFIGURED',
          payload: { kind: 'password_help', username: uname, requestedAt: now.toISOString() },
          now,
        });
      }
    }
    return { ok: true, message: 'اگر حسابی با این نام کاربری وجود داشته باشد، درخواست به مدیریت ارسال شد.' };
  })();
}

module.exports = {
  createGraderAccount, setGraderActive, updateStudent, issuePasswordReset, consumePasswordReset,
  requestPasswordHelp, usernameTaken, verifyPassword,
};
