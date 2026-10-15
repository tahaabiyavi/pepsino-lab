'use strict';
// HTTP-level tests for uploads, role boundaries, cross-access, grader scope,
// answer-key timing, password reset and grader session revocation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeDb, seedAdmin, fakeTelegram, testConfig, SIGNING_KEY, WEBHOOK_SECRET, ADMIN_TG } = require('./helpers');
const { createApp } = require('../src/app');
const exams = require('../src/services/exams');
const grading = require('../src/services/grading');
const { createGraderAccount } = require('../src/services/accounts');
const { tick } = require('../src/services/publication');
const { hashPassword } = require('../src/auth/passwords');

const silent = { error() {}, warn() {}, info() {} };
const ORIGIN = 'http://localhost:3000';
const PDF = () => Buffer.from('%PDF-1.4\n1 0 obj<< /Type /Catalog >> endobj\n%%EOF\n');
const HOUR = 3600e3;

async function start() {
  const db = makeDb();
  seedAdmin(db, 'AdminPass123');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepsino-test-'));
  const config = testConfig({ dataDir });
  const app = createApp({ db, config, telegram: fakeTelegram(), log: silent });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db, base, dataDir,
    close: () => new Promise((r) => server.close(() => { fs.rmSync(dataDir, { recursive: true, force: true }); r(); })),
  };
}

async function req(s, method, url, { cookie, body, form, json } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) payload = form;
  else if (json !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(json); }
  const r = await fetch(s.base + url, { method, headers, body: payload });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: r.status, data, headers: r.headers, text };
}

async function login(s, username, password) {
  const r = await fetch(`${s.base}/api/auth/login`, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const m = /pl_sid=([^;]+)/.exec(r.headers.get('set-cookie') || '');
  return { status: r.status, cookie: m ? `pl_sid=${m[1]}` : null };
}

async function adminCookie(s) {
  const out = await login(s, 'admin', 'AdminPass123');
  assert.equal(out.status, 200);
  return out.cookie;
}

function addStudent(db, username, password = 'StudentPass1') {
  const grade = db.prepare("SELECT id FROM grades WHERE code = 'g10'").get().id;
  const field = db.prepare("SELECT id FROM academic_fields WHERE code = 'math_physics'").get().id;
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO students (username, password_hash, full_name, grade_id, field_id, status, created_at, updated_at, approved_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).run(username, hashPassword(password, 4), `دانش‌آموز ${username}`, grade, field, now, now, now);
  return Number(info.lastInsertRowid);
}

/** Exam with one question and an answer key. Times are set so the window is open now. */
function buildExam(db, { windowOpen = true } = {}) {  // windowOpen kept for call-site readability
  const now = new Date();
  db.prepare("INSERT OR IGNORE INTO academic_years (label, starts_on, ends_on, created_at) VALUES ('1405-1406','2026-09-01','2027-06-30',?)").run(now.toISOString());
  const academicYearId = db.prepare("SELECT id FROM academic_years WHERE label = '1405-1406'").get().id;
  db.prepare("INSERT OR IGNORE INTO subjects (code, label) VALUES ('math', 'ریاضی')").run();
  const subjectId = db.prepare("SELECT id FROM subjects WHERE code = 'math'").get().id;
  const day = 24 * HOUR;
  const future = (ms) => new Date(now.getTime() + ms).toISOString();
  const { id } = exams.createExam(db, {
    title: 'آزمون تست', academicYearId, durationMinutes: 60, gradeCodes: ['g10'],
    startsAt: future(day), submissionDeadline: future(day + 2 * HOUR),
    answerKeyPublishAt: future(2 * day), resultsPublishAt: future(3 * day),
  }, { now });
  db.prepare("INSERT OR IGNORE INTO topics (subject_id, label) VALUES (?, 'جبر')").run(subjectId);
  const topicId = db.prepare("SELECT id FROM topics WHERE subject_id = ? AND label = 'جبر'").get(subjectId).id;
  exams.addQuestion(db, id, { body: 'سوال یک', maxMark: '1', subjectId, topicIds: [topicId], position: 1 }, { now });
  return { id, now, day, academicYearId, windowOpen };
}

function openWindow(db, examId) {
  const now = new Date();
  db.prepare('UPDATE exams SET starts_at = ?, submission_deadline = ? WHERE id = ?')
    .run(new Date(now.getTime() - HOUR).toISOString(), new Date(now.getTime() + HOUR).toISOString(), examId);
}

function closeWindow(db, examId) {
  const past = new Date(Date.now() - 2 * HOUR).toISOString();
  db.prepare('UPDATE exams SET starts_at = ?, submission_deadline = ?, answer_key_publish_at = ?, results_publish_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 3 * HOUR).toISOString(), past, new Date(Date.now() - HOUR).toISOString(), new Date(Date.now() + HOUR).toISOString(), examId);
}

/** Attach a stored answer key directly (the upload route is covered separately). */
function attachKey(s, examId) {
  const { writePrivate, validateUpload } = require('../src/files/storage');
  const meta = validateUpload({ buffer: PDF(), originalName: 'key.pdf' });
  const name = writePrivate(s.dataDir, PDF());
  s.db.prepare(`INSERT INTO answer_keys (exam_id, original_name, mime_type, size_bytes, sha256, storage_name, uploaded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(examId, meta.originalName, meta.mimeType, meta.sizeBytes, meta.sha256, name, new Date().toISOString());
}

function publish(s, examId) {
  exams.transition(s.db, examId, 'published', { actor: 'admin' });
}

function form(buf, name, type = 'application/pdf') {
  const f = new FormData();
  f.append('file', new Blob([buf], { type }), name);
  return f;
}

// ----------------------------------------------------------------- uploads

test('upload: a file over 10 MB is rejected with 413 and nothing is stored', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id); openWindow(s.db, ex.id);
    addStudent(s.db, 'stu_big');
    const c = (await login(s, 'stu_big', 'StudentPass1')).cookie;
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x20)]);
    const r = await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: c, form: form(big, 'big.pdf') });
    assert.equal(r.status, 413);
    assert.equal(r.data.error.code, 'file_too_large');
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM pending_uploads').get().n, 0);
  } finally { await s.close(); }
});

test('upload: unsupported and disguised files are rejected (415) and a clean PDF is accepted (201)', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id); openWindow(s.db, ex.id);
    addStudent(s.db, 'stu_types');
    const c = (await login(s, 'stu_types', 'StudentPass1')).cookie;
    const url = `/api/student/exams/${ex.id}/uploads`;
    const cases = [
      ['malware.exe', Buffer.from('MZ\x90\x00 binary'), 'application/octet-stream'],
      ['script.php', Buffer.from('<?php echo 1; ?>'), 'application/x-php'],
      ['page.html', Buffer.from('<html><script>x</script></html>'), 'text/html'],
      ['fake.png', PDF(), 'image/png'],                   // PDF bytes with a PNG name
      ['bad.pdf', Buffer.from('MZ\x90\x00 exe pretending'), 'application/pdf'],
      ['active.pdf', Buffer.from('%PDF-1.4\n1 0 obj<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>endobj'), 'application/pdf'],
      ['archive.zip', Buffer.from('PK\u0003\u0004'), 'application/zip'],
    ];
    for (const [name, buf, type] of cases) {
      const r = await req(s, 'POST', url, { cookie: c, form: form(buf, name, type) });
      assert.equal(r.status, 415, `${name} should be refused, got ${r.status}`);
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM pending_uploads').get().n, 0);
    const ok = await req(s, 'POST', url, { cookie: c, form: form(PDF(), 'answers.pdf') });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.upload.mime_type, 'application/pdf');
  } finally { await s.close(); }
});

test('upload: a PNG with a valid signature is accepted', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id); openWindow(s.db, ex.id);
    addStudent(s.db, 'stu_png');
    const c = (await login(s, 'stu_png', 'StudentPass1')).cookie;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const r = await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: c, form: form(png, 'sheet.png', 'image/png') });
    assert.equal(r.status, 201);
  } finally { await s.close(); }
});

test('cross-access: a student cannot see, delete or submit another student\'s uploads', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id); openWindow(s.db, ex.id);
    addStudent(s.db, 'stu_a'); addStudent(s.db, 'stu_b');
    const ca = (await login(s, 'stu_a', 'StudentPass1')).cookie;
    const cb = (await login(s, 'stu_b', 'StudentPass1')).cookie;
    const up = await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: ca, form: form(PDF(), 'a.pdf') });
    assert.equal(up.status, 201);
    const list = await req(s, 'GET', `/api/student/exams/${ex.id}/uploads`, { cookie: cb });
    assert.equal(list.data.uploads.length, 0);
    const del = await req(s, 'DELETE', `/api/student/exams/${ex.id}/uploads/${up.data.upload.id}`, { cookie: cb });
    assert.equal(del.status, 404);
    const submitB = await req(s, 'POST', `/api/student/exams/${ex.id}/submit`, { cookie: cb });
    assert.equal(submitB.status, 400);
    assert.equal(submitB.data.error.code, 'no_files');
    // The admin download route is closed to students.
    const adminRoute = await req(s, 'GET', '/api/admin/submission-files/1', { cookie: ca });
    assert.equal(adminRoute.status, 403);
  } finally { await s.close(); }
});

test('submit moves pending files into the submission and locks further uploads', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id); openWindow(s.db, ex.id);
    addStudent(s.db, 'stu_sub');
    const c = (await login(s, 'stu_sub', 'StudentPass1')).cookie;
    await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: c, form: form(PDF(), 'p1.pdf') });
    const sub = await req(s, 'POST', `/api/student/exams/${ex.id}/submit`, { cookie: c });
    assert.equal(sub.status, 201);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM pending_uploads').get().n, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM submission_files').get().n, 1);
    const again = await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: c, form: form(PDF(), 'p2.pdf') });
    assert.equal(again.status, 409);
    const dup = await req(s, 'POST', `/api/student/exams/${ex.id}/submit`, { cookie: c });
    assert.equal(dup.status, 409);
  } finally { await s.close(); }
});

// ----------------------------------------------------------------- answer keys

test('answer key: denied before publication, served after the scheduler publishes it', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id); openWindow(s.db, ex.id);
    addStudent(s.db, 'stu_key');
    const c = (await login(s, 'stu_key', 'StudentPass1')).cookie;
    const before = await req(s, 'GET', `/api/student/exams/${ex.id}/answer-key`, { cookie: c });
    assert.equal(before.status, 403);
    assert.ok(!before.text.includes('endobj'), 'no key bytes before publication');
    // Deadline passes; the scheduler closes the window and releases the key.
    closeWindow(s.db, ex.id);
    s.db.prepare("UPDATE exams SET status = 'submission_closed' WHERE id = ?").run(ex.id);
    tick(s.db, new Date());
    const after = await req(s, 'GET', `/api/student/exams/${ex.id}/answer-key`, { cookie: c });
    assert.equal(after.status, 200);
    assert.equal(after.headers.get('x-content-type-options'), 'nosniff');
    assert.match(after.headers.get('content-disposition'), /attachment/);
  } finally { await s.close(); }
});

// ----------------------------------------------------------------- graders

test('grader scope: sees only own work, cannot reach admin routes or publish', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id); openWindow(s.db, ex.id);
    addStudent(s.db, 'stu_g1'); addStudent(s.db, 'stu_g2');
    for (const u of ['stu_g1', 'stu_g2']) {
      const c = (await login(s, u, 'StudentPass1')).cookie;
      await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: c, form: form(PDF(), 'x.pdf') });
      assert.equal((await req(s, 'POST', `/api/student/exams/${ex.id}/submit`, { cookie: c })).status, 201);
    }
    const g1 = createGraderAccount(s.db, { displayName: 'مصحح یک', username: 'grader_one', password: 'GraderPass1' }, { rounds: 4 });
    createGraderAccount(s.db, { displayName: 'مصحح دو', username: 'grader_two', password: 'GraderPass2' }, { rounds: 4 });
    closeWindow(s.db, ex.id);
    s.db.prepare("UPDATE exams SET status = 'submission_closed' WHERE id = ?").run(ex.id);
    const adminC = await adminCookie(s);
    const dist = await req(s, 'POST', `/api/admin/exams/${ex.id}/distribute`, { cookie: adminC });
    assert.equal(dist.status, 200);
    const cg1 = (await login(s, 'grader_one', 'GraderPass1')).cookie;
    const cg2 = (await login(s, 'grader_two', 'GraderPass2')).cookie;
    const list1 = (await req(s, 'GET', '/api/grader/assignments', { cookie: cg1 })).data.assignments;
    const list2 = (await req(s, 'GET', '/api/grader/assignments', { cookie: cg2 })).data.assignments;
    assert.equal(list1.length + list2.length, 2);
    const ids1 = new Set(list1.map((x) => x.id));
    assert.equal(list2.some((x) => ids1.has(x.id)), false, 'graders must not share assignments');
    const mine = list1[0] || list2[0];
    const theirs = list1.length ? list2[0] : list1[0];
    const otherCookie = list1.length ? cg2 : cg1;
    assert.ok(mine && theirs, 'each grader should hold work when two sheets are split');
    const cross = await req(s, 'GET', `/api/grader/assignments/${theirs.id}`, { cookie: list1.length ? cg1 : cg2 });
    assert.equal(cross.status, 403);
    const own = await req(s, 'GET', `/api/grader/assignments/${mine.id}`, { cookie: list1.length ? cg1 : cg2 });
    assert.equal(own.status, 200);
    assert.equal(own.data.questions[0].explanatory_answer, undefined);
    // Grader is not an admin: admin routes and publication are refused.
    assert.equal((await req(s, 'GET', '/api/admin/exams', { cookie: otherCookie })).status, 403);
    assert.equal((await req(s, 'POST', `/api/admin/exams/${ex.id}/transition`, { cookie: otherCookie, json: { to: 'archived' } })).status, 403);
    assert.equal((await req(s, 'POST', `/api/admin/graders`, { cookie: otherCookie, json: {} })).status, 403);
    assert.ok(g1.id > 0);
  } finally { await s.close(); }
});

test('reassigned work is removed from the grader\'s view and refused', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id); openWindow(s.db, ex.id);
    addStudent(s.db, 'stu_r');
    const c = (await login(s, 'stu_r', 'StudentPass1')).cookie;
    await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: c, form: form(PDF(), 'r.pdf') });
    await req(s, 'POST', `/api/student/exams/${ex.id}/submit`, { cookie: c });
    const g1 = createGraderAccount(s.db, { displayName: 'مصحح الف', username: 'grader_a', password: 'GraderPass1' }, { rounds: 4 });
    const g2 = createGraderAccount(s.db, { displayName: 'مصحح ب', username: 'grader_b', password: 'GraderPass2' }, { rounds: 4 });
    closeWindow(s.db, ex.id);
    s.db.prepare("UPDATE exams SET status = 'submission_closed' WHERE id = ?").run(ex.id);
    grading.distributeExam(s.db, ex.id, { actor: 'admin' });
    const a = s.db.prepare("SELECT * FROM grading_assignments WHERE state = 'active'").get();
    const subId = a.submission_id;
    const other = a.grader_id === g1.id ? g2.id : g1.id;
    const adminC = await adminCookie(s);
    const r = await req(s, 'POST', `/api/admin/submissions/${subId}/reassign`, { cookie: adminC, json: { graderId: other, reason: 'تست' } });
    assert.equal(r.status, 200);
    const oldGraderCookie = a.grader_id === g1.id
      ? (await login(s, 'grader_a', 'GraderPass1')).cookie
      : (await login(s, 'grader_b', 'GraderPass2')).cookie;
    const denied = await req(s, 'GET', `/api/grader/assignments/${a.id}`, { cookie: oldGraderCookie });
    assert.equal(denied.status, 403);
    const list = await req(s, 'GET', '/api/grader/assignments', { cookie: oldGraderCookie });
    assert.equal(list.data.assignments.some((x) => x.id === a.id), false);
  } finally { await s.close(); }
});

test('disabled grader: active session is revoked and login is refused', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id);
    const g = createGraderAccount(s.db, { displayName: 'مصحح موقت', username: 'grader_off', password: 'GraderPass1' }, { rounds: 4 });
    const c = (await login(s, 'grader_off', 'GraderPass1')).cookie;
    assert.equal((await req(s, 'GET', '/api/grader/assignments', { cookie: c })).status, 200);
    const adminC = await adminCookie(s);
    const off = await req(s, 'POST', `/api/admin/graders/${g.id}/active`, { cookie: adminC, json: { active: false } });
    assert.equal(off.status, 200);
    assert.equal((await req(s, 'GET', '/api/grader/assignments', { cookie: c })).status, 401);
    const relogin = await login(s, 'grader_off', 'GraderPass1');
    assert.equal(relogin.status, 403);
  } finally { await s.close(); }
});

// ----------------------------------------------------------------- password reset

test('password reset: admin-issued token works once and revokes old sessions', async () => {
  const s = await start();
  try {
    const sid = addStudent(s.db, 'stu_reset', 'OldPass1234');
    const oldSession = (await login(s, 'stu_reset', 'OldPass1234')).cookie;
    assert.equal((await req(s, 'GET', '/api/student/me', { cookie: oldSession })).status, 200);
    const adminC = await adminCookie(s);
    const issued = await req(s, 'POST', `/api/admin/students/${sid}/password-reset`, { cookie: adminC });
    assert.equal(issued.status, 200);
    const token = issued.data.token;
    assert.ok(token && token.length > 20);
    // Only a hash is stored.
    const stored = JSON.stringify(s.db.prepare('SELECT * FROM password_resets').all());
    assert.equal(stored.includes(token), false);
    const wrongUser = await req(s, 'POST', '/api/auth/password-reset', { json: { username: 'someone_else', token, newPassword: 'NewPass1234' } });
    assert.equal(wrongUser.status, 400);
    const ok = await req(s, 'POST', '/api/auth/password-reset', { json: { username: 'stu_reset', token, newPassword: 'NewPass1234' } });
    assert.equal(ok.status, 200);
    assert.equal((await login(s, 'stu_reset', 'OldPass1234')).status, 401);
    assert.equal((await login(s, 'stu_reset', 'NewPass1234')).status, 200);
    assert.equal((await req(s, 'GET', '/api/student/me', { cookie: oldSession })).status, 401);
    const reuse = await req(s, 'POST', '/api/auth/password-reset', { json: { username: 'stu_reset', token, newPassword: 'Another1234' } });
    assert.equal(reuse.status, 400);
  } finally { await s.close(); }
});

test('password help: generic response for unknown and known usernames', async () => {
  const s = await start();
  try {
    addStudent(s.db, 'stu_help');
    const a = await req(s, 'POST', '/api/auth/password-help', { json: { username: 'nobody_here' } });
    const b = await req(s, 'POST', '/api/auth/password-help', { json: { username: 'stu_help' } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.data.message, b.data.message);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE channel = 'telegram_admin'").get().n, 1);
  } finally { await s.close(); }
});

void WEBHOOK_SECRET; void SIGNING_KEY; void ADMIN_TG;
