'use strict';
// Unified login for the administrator and students.
// The role is decided by the server from the stored account, never by a
// client-supplied field. Failures return one generic message so that account
// existence cannot be probed. Status messages (pending / disabled) appear only
// after the correct password is supplied.
const { verifyPassword, DUMMY_HASH } = require('../auth/passwords');
const { createSession } = require('../auth/sessions');
const { AppError } = require('./errors');
const { recordAudit } = require('./audit');
const { normalizeUsername } = require('./validation');

const INVALID = () => new AppError(401, 'invalid_credentials', 'نام کاربری یا رمز عبور اشتباه است');

function login(db, { username, password, userAgent }, cfg = {}) {
  const now = cfg.now || new Date();
  const uname = normalizeUsername(username);
  if (!uname || typeof password !== 'string' || password.length === 0 || password.length > 128) {
    throw INVALID();
  }
  const sessionOpts = {
    idleHours: cfg.sessionTtlHours || 8,
    absoluteHours: cfg.sessionAbsoluteHours || 24,
    now,
    userAgent,
  };

  // Administrator (single account).
  const admin = db.prepare('SELECT * FROM admin_account WHERE id = 1').get();
  if (admin && uname === admin.username.toLowerCase()) {
    if (!verifyPassword(password, admin.password_hash)) {
      recordAudit(db, { actor: 'anonymous', action: 'auth.login_failed', details: { role: 'admin' } }, now);
      throw INVALID();
    }
    const token = createSession(db, { subjectType: 'admin', subjectId: 1, ...sessionOpts });
    recordAudit(db, { actor: 'admin', action: 'auth.login', details: { role: 'admin' } }, now);
    return { token, subject: { type: 'admin', id: 1, username: admin.username } };
  }

  // Grader (own login, no administrator privileges).
  const grader = db.prepare('SELECT * FROM grader_profiles WHERE username = ?').get(uname);
  if (grader && grader.password_hash) {
    if (!verifyPassword(password, grader.password_hash)) {
      recordAudit(db, { actor: `grader:${grader.id}`, action: 'auth.login_failed', entityType: 'grader', entityId: grader.id }, now);
      throw INVALID();
    }
    if (!grader.active) throw new AppError(403, 'account_disabled', 'حساب شما غیرفعال است. با مدیریت تماس بگیرید.');
    const token = createSession(db, { subjectType: 'grader', subjectId: grader.id, ...sessionOpts });
    recordAudit(db, { actor: `grader:${grader.id}`, action: 'auth.login', entityType: 'grader', entityId: grader.id }, now);
    return { token, subject: { type: 'grader', id: grader.id, username: grader.username, displayName: grader.display_name } };
  }

  // Student.
  const student = db.prepare('SELECT * FROM students WHERE username = ? COLLATE NOCASE').get(uname);
  if (!student) {
    verifyPassword(password, DUMMY_HASH); // equalise timing
    throw INVALID();
  }
  if (!verifyPassword(password, student.password_hash)) {
    recordAudit(db, { actor: `student:${student.id}`, action: 'auth.login_failed', entityType: 'student', entityId: student.id }, now);
    throw INVALID();
  }
  if (student.status !== 'active') {
    throw new AppError(403, 'account_disabled', 'حساب شما غیرفعال است. با مدیریت تماس بگیرید.');
  }
  const token = createSession(db, { subjectType: 'student', subjectId: student.id, ...sessionOpts });
  recordAudit(db, { actor: `student:${student.id}`, action: 'auth.login', entityType: 'student', entityId: student.id }, now);
  return { token, subject: { type: 'student', id: student.id, username: student.username, fullName: student.full_name } };
}

module.exports = { login };
