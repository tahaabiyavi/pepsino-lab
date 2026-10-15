'use strict';
// Server-side sessions. The cookie carries a random token; the database
// stores only its SHA-256 digest. Sessions expire on idle timeout and on an
// absolute lifetime. The subject's status is re-checked on every request,
// so disabling an account revokes access immediately.
const crypto = require('crypto');

const COOKIE_NAME = 'pl_sid';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(db, { subjectType, subjectId, userAgent = null, idleHours = 8, absoluteHours = 24, now = new Date() }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const nowIso = now.toISOString();
  const idleExp = new Date(now.getTime() + idleHours * 3600e3);
  const absExp = new Date(now.getTime() + absoluteHours * 3600e3);
  db.prepare(
    `INSERT INTO sessions (token_hash, subject_type, subject_id, created_at, last_seen_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(hashToken(token), subjectType, subjectId, nowIso, nowIso,
    new Date(Math.min(idleExp, absExp)).toISOString(), userAgent ? String(userAgent).slice(0, 200) : null);
  return token;
}

/**
 * Resolve a cookie token to an authenticated subject, or null.
 * Re-validates that the subject is still allowed to act.
 */
function resolveSession(db, token, { now = new Date(), idleHours = 8, absoluteHours = 24 } = {}) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!row) return null;

  const nowMs = now.getTime();
  const absoluteMs = new Date(row.created_at).getTime() + absoluteHours * 3600e3;
  if (new Date(row.expires_at).getTime() <= nowMs || absoluteMs <= nowMs) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }

  let subject = null;
  if (row.subject_type === 'admin') {
    subject = db.prepare('SELECT id, username FROM admin_account WHERE id = ?').get(row.subject_id);
    if (subject) subject = { type: 'admin', id: subject.id, username: subject.username };
  } else if (row.subject_type === 'grader') {
    const g = db.prepare('SELECT id, username, display_name, active FROM grader_profiles WHERE id = ?').get(row.subject_id);
    if (g && g.active === 1) {
      subject = { type: 'grader', id: g.id, username: g.username, displayName: g.display_name };
      db.prepare('UPDATE grader_profiles SET last_active_at = ? WHERE id = ?').run(now.toISOString(), g.id);
    }
  } else {
    const s = db.prepare('SELECT id, username, full_name, status FROM students WHERE id = ?').get(row.subject_id);
    if (s && s.status === 'active') subject = { type: 'student', id: s.id, username: s.username, fullName: s.full_name };
  }
  if (!subject) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }

  const idleExpires = new Date(Math.min(nowMs + idleHours * 3600e3, absoluteMs)).toISOString();
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
    .run(now.toISOString(), idleExpires, row.token_hash);
  return subject;
}

function revokeSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

function revokeGraderSessions(db, graderId) {
  return db.prepare("DELETE FROM sessions WHERE subject_type = 'grader' AND subject_id = ?").run(graderId).changes;
}

function revokeStudentSessions(db, studentId) {
  return db.prepare("DELETE FROM sessions WHERE subject_type = 'student' AND subject_id = ?").run(studentId).changes;
}

function purgeExpiredSessions(db, now = new Date()) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString()).changes;
}

module.exports = {
  COOKIE_NAME, createSession, resolveSession, revokeSession, revokeStudentSessions, revokeGraderSessions, purgeExpiredSessions, hashToken,
};
