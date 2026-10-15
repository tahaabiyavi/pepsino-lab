'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, seedAdmin, VALID_REG } = require('./helpers');
const { submitRegistration, decideRegistration } = require('../src/services/registration');
const { login } = require('../src/services/login');
const { createSession, resolveSession, revokeStudentSessions } = require('../src/auth/sessions');
const { checkPasswordPolicy, hashPassword, verifyPassword } = require('../src/auth/passwords');
const { validateRegistrationInput } = require('../src/services/validation');

function approvedStudent(db) {
  const r = submitRegistration(db, VALID_REG, { rounds: 4 });
  decideRegistration(db, { requestId: r.id, action: 'accept', actor: 'admin', source: 'web' });
  return db.prepare('SELECT * FROM students WHERE username = ?').get(VALID_REG.username);
}

test('password hashing is salted and verifiable', () => {
  const a = hashPassword('Abcdef12', 4), b = hashPassword('Abcdef12', 4);
  assert.notEqual(a, b);
  assert.equal(verifyPassword('Abcdef12', a), true);
  assert.equal(verifyPassword('Abcdef13', a), false);
});

test('password policy: length and letter+digit requirement', () => {
  assert.ok(checkPasswordPolicy('short1'));
  assert.ok(checkPasswordPolicy('onlyletters'));
  assert.ok(checkPasswordPolicy('12345678'));
  assert.equal(checkPasswordPolicy('Secret1234'), null);
});

test('admin login succeeds; wrong password gets generic error', () => {
  const db = makeDb();
  seedAdmin(db, 'AdminPass123');
  const ok = login(db, { username: 'admin', password: 'AdminPass123' });
  assert.equal(ok.subject.type, 'admin');
  assert.throws(() => login(db, { username: 'admin', password: 'nope' }), (e) => e.code === 'invalid_credentials');
  assert.throws(() => login(db, { username: 'nobody', password: 'nope1234' }), (e) => e.code === 'invalid_credentials');
});

test('login role is decided by the server, not the request body', () => {
  const db = makeDb();
  seedAdmin(db);
  const s = approvedStudent(db);
  const out = login(db, { username: VALID_REG.username, password: VALID_REG.password, role: 'admin' });
  assert.equal(out.subject.type, 'student');
  assert.equal(out.subject.id, s.id);
});

test('pending applicants cannot log in (no account yet)', () => {
  const db = makeDb();
  submitRegistration(db, VALID_REG, { rounds: 4 });
  assert.throws(() => login(db, { username: VALID_REG.username, password: VALID_REG.password }), (e) => e.code === 'invalid_credentials');
});

test('disabled student: login refused and existing sessions revoked', () => {
  const db = makeDb();
  const s = approvedStudent(db);
  const { token } = login(db, { username: VALID_REG.username, password: VALID_REG.password });
  assert.ok(resolveSession(db, token));
  db.prepare("UPDATE students SET status = 'disabled', disabled_at = ? WHERE id = ?").run(new Date().toISOString(), s.id);
  revokeStudentSessions(db, s.id);
  assert.equal(resolveSession(db, token), null);
  assert.throws(() => login(db, { username: VALID_REG.username, password: VALID_REG.password }), (e) => e.status === 403 && e.code === 'account_disabled');
});

test('session tokens are stored hashed, never raw', () => {
  const db = makeDb();
  seedAdmin(db);
  const { token } = login(db, { username: 'admin', password: 'AdminPass123' });
  const rows = db.prepare('SELECT token_hash FROM sessions').all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.equal(rows[0].token_hash.includes(token), false);
});

test('session expires after idle timeout and after absolute lifetime', () => {
  const db = makeDb();
  seedAdmin(db);
  const t0 = new Date('2026-10-10T08:00:00Z');
  const token = createSession(db, { subjectType: 'admin', subjectId: 1, idleHours: 1, absoluteHours: 3, now: t0 });
  // Within idle window: valid and sliding.
  assert.ok(resolveSession(db, token, { now: new Date(t0.getTime() + 30 * 60e3), idleHours: 1, absoluteHours: 3 }));
  // Idle beyond limit: expired.
  assert.equal(resolveSession(db, token, { now: new Date(t0.getTime() + 3 * 3600e3), idleHours: 1, absoluteHours: 3 }), null);

  // Keep it active but exceed absolute lifetime.
  const token2 = createSession(db, { subjectType: 'admin', subjectId: 1, idleHours: 1, absoluteHours: 3, now: t0 });
  let t = t0;
  for (let i = 0; i < 4; i++) {
    t = new Date(t.getTime() + 50 * 60e3);
    resolveSession(db, token2, { now: t, idleHours: 1, absoluteHours: 3 });
  }
  assert.equal(resolveSession(db, token2, { now: new Date(t0.getTime() + 4 * 3600e3), idleHours: 1, absoluteHours: 3 }), null);
});

test('registration validation rejects markup and reserved usernames', () => {
  assert.throws(() => validateRegistrationInput({ ...VALID_REG, username: 'admin' }), (e) => Boolean(e.details.username));
  assert.throws(() => validateRegistrationInput({ ...VALID_REG, fullName: 'a<b>c' }), (e) => Boolean(e.details.fullName));
  assert.throws(() => validateRegistrationInput({ ...VALID_REG, username: 'bad name!' }), (e) => Boolean(e.details.username));
});
