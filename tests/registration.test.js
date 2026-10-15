'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, VALID_REG, ADMIN_TG } = require('./helpers');
const { submitRegistration, decideRegistration } = require('../src/services/registration');
const { verifyPassword } = require('../src/auth/passwords');
const { AppError } = require('../src/services/errors');

const submit = (db, over = {}) => submitRegistration(db, { ...VALID_REG, ...over }, { rounds: 4, adminChatId: '-100123' });

test('successful registration creates a pending request and no account', () => {
  const db = makeDb();
  const r = submit(db);
  assert.equal(r.status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 0);
  assert.equal(db.prepare("SELECT status FROM registration_requests WHERE id = ?").get(r.id).status, 'pending');
});

test('password is stored only as a bcrypt hash, never in plaintext', () => {
  const db = makeDb();
  const r = submit(db);
  const row = db.prepare('SELECT password_hash FROM registration_requests WHERE id = ?').get(r.id);
  assert.match(row.password_hash, /^\$2[aby]\$/);
  assert.notEqual(row.password_hash, VALID_REG.password);
  assert.equal(verifyPassword(VALID_REG.password, row.password_hash), true);
  // The plaintext must not appear anywhere in the database.
  const dump = JSON.stringify(db.prepare('SELECT * FROM audit_log').all()) +
    JSON.stringify(db.prepare('SELECT payload FROM notification_outbox').all());
  assert.equal(dump.includes(VALID_REG.password), false);
});

test('admin notification is queued with a dedupe key', () => {
  const db = makeDb();
  const r = submit(db);
  const rows = db.prepare('SELECT * FROM notification_outbox').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dedupe_key, `registration:new:${r.id}`);
  assert.equal(rows[0].channel, 'telegram_admin');
  assert.equal(JSON.parse(rows[0].payload).username, VALID_REG.username);
  assert.equal(rows[0].payload.includes('Secret1234'), false);
});

test('duplicate pending username is rejected', () => {
  const db = makeDb();
  submit(db);
  assert.throws(() => submit(db), (e) => e instanceof AppError && e.code === 'registration_pending');
});

test('username comparison is case-insensitive', () => {
  const db = makeDb();
  submit(db, { username: 'Ali_Test' });
  assert.throws(() => submit(db, { username: 'ALI_TEST' }), (e) => e.code === 'registration_pending');
});

test('invalid input is rejected with field-level details', () => {
  const db = makeDb();
  assert.throws(() => submit(db, { username: 'x', password: 'short', fullName: '<script>' }), (e) => {
    return e.status === 400 && e.code === 'validation_failed' &&
      Boolean(e.details.username && e.details.password && e.details.fullName);
  });
  assert.throws(() => submit(db, { gradeCode: 'g99' }), (e) => e.code === 'validation_failed' && Boolean(e.details.gradeCode));
});

test('accept activates the account, clears the hash, and is idempotent', () => {
  const db = makeDb();
  const r = submit(db);
  const first = decideRegistration(db, { requestId: r.id, action: 'accept', actor: `telegram:${ADMIN_TG}`, source: 'telegram' });
  assert.equal(first.changed, true);
  const student = db.prepare('SELECT * FROM students WHERE username = ?').get(VALID_REG.username);
  assert.equal(student.status, 'active');
  assert.equal(verifyPassword(VALID_REG.password, student.password_hash), true);
  assert.equal(db.prepare('SELECT password_hash FROM registration_requests WHERE id = ?').get(r.id).password_hash, null);

  const second = decideRegistration(db, { requestId: r.id, action: 'accept', actor: `telegram:${ADMIN_TG}`, source: 'telegram' });
  assert.equal(second.alreadyApplied, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 1, 'no duplicate account');
});

test('opposite decision after acceptance is refused', () => {
  const db = makeDb();
  const r = submit(db);
  decideRegistration(db, { requestId: r.id, action: 'accept', actor: 'admin', source: 'web' });
  assert.throws(() => decideRegistration(db, { requestId: r.id, action: 'reject', actor: 'admin', source: 'web' }),
    (e) => e.code === 'already_decided');
});

test('reject is recorded and the student may resubmit', () => {
  const db = makeDb();
  const r = submit(db);
  const out = decideRegistration(db, { requestId: r.id, action: 'reject', actor: 'admin', source: 'web' });
  assert.equal(out.status, 'rejected');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 0);
  const again = submit(db);
  assert.equal(again.status, 'pending');
  assert.notEqual(again.id, r.id);
});

test('repeated reject is idempotent', () => {
  const db = makeDb();
  const r = submit(db);
  decideRegistration(db, { requestId: r.id, action: 'reject', actor: 'admin', source: 'web' });
  const again = decideRegistration(db, { requestId: r.id, action: 'reject', actor: 'admin', source: 'web' });
  assert.equal(again.alreadyApplied, true);
});

test('accept does not overwrite an account that took the username meanwhile', () => {
  const db = makeDb();
  const r = submit(db);
  // Another account appears with this username (simulated direct insert).
  const grade = db.prepare('SELECT id FROM grades LIMIT 1').get();
  const field = db.prepare('SELECT id FROM academic_fields LIMIT 1').get();
  db.prepare(`INSERT INTO students (username, password_hash, full_name, grade_id, field_id, status, created_at, updated_at)
              VALUES (?, 'x', 'Other', ?, ?, 'active', '2026-01-01', '2026-01-01')`).run(VALID_REG.username, grade.id, field.id);
  // Request has since been ... actually the uniqueness check happens at submit; simulate the race directly.
  assert.throws(() => decideRegistration(db, { requestId: r.id, action: 'accept', actor: 'admin', source: 'web' }),
    (e) => e.code === 'username_taken');
  assert.equal(db.prepare('SELECT status FROM registration_requests WHERE id = ?').get(r.id).status, 'pending');
});

test('unknown request id returns not found', () => {
  const db = makeDb();
  assert.throws(() => decideRegistration(db, { requestId: 9999, action: 'accept', actor: 'admin', source: 'web' }),
    (e) => e.status === 404);
});
