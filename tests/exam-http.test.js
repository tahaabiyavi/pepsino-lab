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
/** یک PNGِ واقعی (حداقلِ معتبر) — برای آزمودنِ پاسخ‌برگ‌هایی که با گوشی عکس گرفته می‌شوند. */
const PNG = () => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]), Buffer.from('IHDR'), Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00]),
  Buffer.from([0x90, 0x77, 0x53, 0xde]),
  Buffer.from([0x00, 0x00, 0x00, 0x0c]), Buffer.from('IDAT'), Buffer.from([0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x9f, 0x81, 0x81, 0x01, 0x00]),
  Buffer.from([0x0f, 0x67, 0x02, 0xfe]),
  Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('IEND'), Buffer.from([0xae, 0x42, 0x60, 0x82]),
]);
/** یک MP3 واقعی (تگ ID3 + ۳ فریم MPEG خالی) — برای آزمودنِ فایلِ لیسنینگ. */
const MP3 = () => {
  const frame = () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]);
  return Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    frame(), frame(), frame(),
  ]);
};
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


/* ===================== ویرایش و حذف آزمون ===================== */


/** یک درسِ نمونه در پایگاهِ تست می‌سازد (پایگاهِ تست خالی است) و id آن را برمی‌گرداند. */
function seedSubject(db) {
  const found = db.prepare('SELECT id FROM subjects LIMIT 1').get();
  if (found) return found.id;
  const info = db.prepare("INSERT INTO subjects (code, label, active) VALUES ('bio', 'زیست‌شناسی', 1)").run();
  return Number(info.lastInsertRowid);
}

/** یک آزمونِ ساده در وضعیتِ draft می‌سازد و id آن را برمی‌گرداند. */
function makeDraftExam(db, title = 'آزمون قابل ویرایش') {
  db.prepare("INSERT OR IGNORE INTO academic_years (label, starts_on, ends_on, created_at) VALUES ('1405-1406','2026-09-01','2027-06-30',?)").run(new Date().toISOString());
  const yearId = db.prepare("SELECT id FROM academic_years WHERE label = '1405-1406'").get().id;
  const t0 = Date.now();
  const out = exams.createExam(db, {
    title,
    durationMinutes: 60,
    gradeCodes: ['g10'],
    academicYearId: yearId,
    startsAt: new Date(t0 + 24 * 3600e3).toISOString(),
    submissionDeadline: new Date(t0 + 26 * 3600e3).toISOString(),
    answerKeyPublishAt: new Date(t0 + 48 * 3600e3).toISOString(),
    resultsPublishAt: new Date(t0 + 72 * 3600e3).toISOString(),
  }, { actor: 'test' });
  return out.id;
}

test('admin can edit an exam title and duration', async () => {
  const s = await start();
  try {
    const admin = (await login(s, 'admin', 'AdminPass123')).cookie;
    const id = makeDraftExam(s.db);

    const r = await req(s, 'PATCH', `/api/admin/exams/${id}`, {
      cookie: admin, json: { title: 'عنوانِ تازه', durationMinutes: 120 },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.title, 'عنوانِ تازه');
    assert.equal(r.data.duration_minutes, 120);

    // در پایگاه داده هم واقعاً عوض شده باشد
    const row = s.db.prepare('SELECT title, duration_minutes FROM exams WHERE id = ?').get(id);
    assert.equal(row.title, 'عنوانِ تازه');
    assert.equal(row.duration_minutes, 120);

    // زمان‌بندی باید دست‌نخورده بماند
    const before = s.db.prepare('SELECT starts_at FROM exams WHERE id = ?').get(id).starts_at;
    await req(s, 'PATCH', `/api/admin/exams/${id}`, { cookie: admin, json: { title: 'فقط عنوان' } });
    assert.equal(s.db.prepare('SELECT starts_at FROM exams WHERE id = ?').get(id).starts_at, before);
  } finally { await s.close(); }
});

test('exam edit rejects invalid title and duration', async () => {
  const s = await start();
  try {
    const admin = (await login(s, 'admin', 'AdminPass123')).cookie;
    const id = makeDraftExam(s.db);

    const short = await req(s, 'PATCH', `/api/admin/exams/${id}`, { cookie: admin, json: { title: 'ab' } });
    assert.equal(short.status, 400);
    assert.equal(short.data.error.code, 'validation_failed');

    for (const bad of [4, 301, 0, -10, 12.5]) {
      const r = await req(s, 'PATCH', `/api/admin/exams/${id}`, { cookie: admin, json: { durationMinutes: bad } });
      assert.equal(r.status, 400, `مدت ${bad} باید رد می‌شد`);
    }
    // مقدارِ نامعتبر نباید ذخیره شود
    assert.equal(s.db.prepare('SELECT duration_minutes FROM exams WHERE id = ?').get(id).duration_minutes, 60);
  } finally { await s.close(); }
});

test('exam edit requires admin; students cannot edit', async () => {
  const s = await start();
  try {
    addStudent(s.db, 'stu_editor');
    const stu = (await login(s, 'stu_editor', 'StudentPass1')).cookie;
    const id = makeDraftExam(s.db);

    assert.equal((await req(s, 'PATCH', `/api/admin/exams/${id}`, { cookie: stu, json: { title: 'دستکاری' } })).status, 403);
    assert.equal((await req(s, 'DELETE', `/api/admin/exams/${id}`, { cookie: stu })).status, 403);
    assert.equal((await req(s, 'PATCH', `/api/admin/exams/${id}`, { json: { title: 'بدون ورود' } })).status, 401);
    assert.equal(s.db.prepare('SELECT title FROM exams WHERE id = ?').get(id).title, 'آزمون قابل ویرایش');
  } finally { await s.close(); }
});

test('admin can delete an exam and its dependent rows', async () => {
  const s = await start();
  try {
    const admin = (await login(s, 'admin', 'AdminPass123')).cookie;
    const id = makeDraftExam(s.db);
    const subjId = seedSubject(s.db);
    s.db.prepare('INSERT INTO questions (exam_id, position, subject_id, body, max_quarters) VALUES (?, 1, ?, ?, 8)')
      .run(id, subjId, 'سؤال نمونه');
    assert.ok(s.db.prepare('SELECT id FROM questions WHERE exam_id = ?').get(id).id);

    const r = await req(s, 'DELETE', `/api/admin/exams/${id}`, { cookie: admin });
    assert.equal(r.status, 200);
    assert.equal(r.data.id, id);

    // خود آزمون و سؤالاتش رفته باشند
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM exams WHERE id = ?').get(id).n, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM questions WHERE exam_id = ?').get(id).n, 0);
    // دیگر قابل دسترسی نباشد
    assert.equal((await req(s, 'GET', `/api/admin/exams/${id}`, { cookie: admin })).status, 404);
  } finally { await s.close(); }
});

test('deleting an exam detaches (not destroys) practice sets and strategic phases', async () => {
  const s = await start();
  try {
    const admin = (await login(s, 'admin', 'AdminPass123')).cookie;
    const id = makeDraftExam(s.db);

    const gradeId = s.db.prepare("SELECT id FROM grades WHERE code = 'g10'").get().id;
    const subjId = seedSubject(s.db);
    const now = new Date().toISOString();
    s.db.prepare(`INSERT INTO practice_sets (title, grade_id, subject_id, active, created_at, created_by, source_exam_id)
                  VALUES ('تمرین نمونه', ?, ?, 1, ?, 'test', ?)`).run(gradeId, subjId, now, id);
    s.db.prepare(`INSERT INTO strategic_phases (title, grade_id, starts_at, ends_at, sort_order, active, exam_id, created_at, updated_at)
                  VALUES ('مرحله نمونه', ?, ?, ?, 1, 1, ?, ?, ?)`)
      .run(gradeId, new Date(Date.now() + 3600e3).toISOString(), new Date(Date.now() + 7200e3).toISOString(), id, now, now);

    assert.equal((await req(s, 'DELETE', `/api/admin/exams/${id}`, { cookie: admin })).status, 200);

    // هر دو باقی می‌مانند و فقط لینکشان خالی می‌شود
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM practice_sets').get().n, 1);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM strategic_phases').get().n, 1);
    assert.equal(s.db.prepare('SELECT source_exam_id FROM practice_sets').get().source_exam_id, null);
    assert.equal(s.db.prepare('SELECT exam_id FROM strategic_phases').get().exam_id, null);
  } finally { await s.close(); }
});

test('archived exams cannot be edited', async () => {
  const s = await start();
  try {
    const admin = (await login(s, 'admin', 'AdminPass123')).cookie;
    const id = makeDraftExam(s.db);
    s.db.prepare("UPDATE exams SET status = 'archived' WHERE id = ?").run(id);
    const r = await req(s, 'PATCH', `/api/admin/exams/${id}`, { cookie: admin, json: { title: 'تغییر ممنوع' } });
    assert.equal(r.status, 409);
  } finally { await s.close(); }
});


/** سالِ تحصیلیِ نمونه را در پایگاهِ تست تضمین می‌کند. */
function db_year(db) {
  db.prepare("INSERT OR IGNORE INTO academic_years (label, starts_on, ends_on, created_at) VALUES ('1405-1406','2026-09-01','2027-06-30',?)").run(new Date().toISOString());
}


/* ============ فهرستِ مصحح: نام دانش‌آموز و پایه ============ */

test('grader assignment list exposes student name and grade', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id); openWindow(s.db, ex.id);
    addStudent(s.db, 'stu_grade');
    const c = (await login(s, 'stu_grade', 'StudentPass1')).cookie;
    await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: c, form: form(PDF(), 'g.pdf') });
    await req(s, 'POST', `/api/student/exams/${ex.id}/submit`, { cookie: c });

    createGraderAccount(s.db, { displayName: 'مصحح نام‌دار', username: 'grader_name', password: 'GraderPass1' }, { rounds: 4 });
    closeWindow(s.db, ex.id);
    s.db.prepare("UPDATE exams SET status = 'submission_closed' WHERE id = ?").run(ex.id);
    grading.distributeExam(s.db, ex.id, { actor: 'admin' });

    const cg = (await login(s, 'grader_name', 'GraderPass1')).cookie;
    const r = await req(s, 'GET', '/api/grader/assignments', { cookie: cg });
    assert.equal(r.status, 200);
    assert.ok(r.data.assignments.length >= 1);
    const row = r.data.assignments[0];
    // نامِ دانش‌آموز و پایه‌اش باید در فهرست باشد (کنارِ دکمه‌ی شروع تصحیح)
    assert.equal(row.student_name, 'دانش‌آموز stu_grade');
    assert.equal(row.grade_label, 'پایه دهم');
    assert.equal(row.grade_code, 'g10');

    // جزئیاتِ تخصیص هم همان اطلاعات را دارد
    const d = await req(s, 'GET', `/api/grader/assignments/${row.id}`, { cookie: cg });
    assert.equal(d.status, 200);
    assert.equal(d.data.assignment.studentName, 'دانش‌آموز stu_grade');
    assert.equal(d.data.assignment.gradeLabel, 'پایه دهم');
    assert.equal(d.data.assignment.examTitle, 'آزمون تست');
  } finally { await s.close(); }
});

test('grader sees every uploaded answer-sheet file, not just the first', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id); openWindow(s.db, ex.id);
    addStudent(s.db, 'stu_files');
    const c = (await login(s, 'stu_files', 'StudentPass1')).cookie;
    // ترکیبی از PDF و تصویر، همان‌طور که دانش‌آموزها واقعاً می‌فرستند
    await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: c, form: form(PDF(), 'a.pdf') });
    await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: c, form: form(PNG(), 'b.png') });
    await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: c, form: form(PDF(), 'c.pdf') });
    await req(s, 'POST', `/api/student/exams/${ex.id}/submit`, { cookie: c });

    createGraderAccount(s.db, { displayName: 'مصحح فایل‌ها', username: 'grader_files', password: 'GraderPass1' }, { rounds: 4 });
    closeWindow(s.db, ex.id);
    s.db.prepare("UPDATE exams SET status = 'submission_closed' WHERE id = ?").run(ex.id);
    grading.distributeExam(s.db, ex.id, { actor: 'admin' });

    const cg = (await login(s, 'grader_files', 'GraderPass1')).cookie;
    const list = (await req(s, 'GET', '/api/grader/assignments', { cookie: cg })).data.assignments;
    const row = list[0];
    // فهرست تعدادِ فایل‌ها را هم می‌گوید
    assert.equal(row.file_count, 3);

    const d = await req(s, 'GET', `/api/grader/assignments/${row.id}`, { cookie: cg });
    assert.equal(d.status, 200);
    // همه‌ی فایل‌ها برگردانده می‌شوند تا مصحح بتواند بینشان بچرخد
    assert.equal(d.data.files.length, 3);
    assert.deepEqual(d.data.files.map((f) => f.original_name).sort(), ['a.pdf', 'b.png', 'c.pdf']);
    // هر کدام نشانیِ خودش را دارد و قابل نمایش است
    for (const f of d.data.files) {
      assert.equal((await req(s, 'GET', `/api/grader/assignments/${row.id}/files/${f.id}?inline=1`, { cookie: cg })).status, 200);
    }
    // فایلِ آزمونِ دیگری از این مصحح قابل دسترسی نیست
    assert.equal((await req(s, 'GET', `/api/grader/assignments/${row.id}/files/999999`, { cookie: cg })).status, 404);
  } finally { await s.close(); }
});

test('student can upload several answer-sheet files for one exam', async () => {
  const s = await start();
  try {
    const ex = buildExam(s.db); attachKey(s, ex.id); publish(s, ex.id); openWindow(s.db, ex.id);
    addStudent(s.db, 'stu_multi');
    const c = (await login(s, 'stu_multi', 'StudentPass1')).cookie;

    // سه فایلِ پشتِ سر هم (رفتارِ کلاینت پس از اصلاح: دیگر فقط files[0] نمی‌رود)
    for (const n of ['one.pdf', 'two.pdf', 'three.pdf']) {
      const up = await req(s, 'POST', `/api/student/exams/${ex.id}/uploads`, { cookie: c, form: form(PDF(), n) });
      assert.equal(up.status, 201, `آپلودِ ${n} باید پذیرفته می‌شد`);
    }
    // هر سه در فهرستِ آپلودها هستند، نه فقط اولی
    const list = await req(s, 'GET', `/api/student/exams/${ex.id}/uploads`, { cookie: c });
    assert.equal(list.status, 200);
    assert.equal(list.data.uploads.length, 3);
    assert.deepEqual(list.data.uploads.map((u) => u.original_name), ['one.pdf', 'two.pdf', 'three.pdf']);

    // و همگی هنگامِ ثبتِ نهایی به submission_files منتقل می‌شوند
    const fin = await req(s, 'POST', `/api/student/exams/${ex.id}/submit`, { cookie: c, json: {} });
    assert.equal(fin.status, 201);
    const n = s.db.prepare('SELECT COUNT(*) n FROM submission_files WHERE submission_id = ?').get(fin.data.submission.id).n;
    assert.equal(n, 3, 'هر سه فایل باید در ارسالِ نهایی باشند');
  } finally { await s.close(); }
});

void WEBHOOK_SECRET; void SIGNING_KEY; void ADMIN_TG;

// ------------------------------------------- فایل صوتیِ لیسنینگ (فقط انگلیسی)

/** یک آزمونِ «باز» می‌سازد و درسِ داده‌شده را به آن می‌چسباند. */
function makeOpenExam(db, { title, subjectCode, subjectLabel, durationMinutes = 60 }) {
  db.prepare("INSERT OR IGNORE INTO academic_years (label, starts_on, ends_on, created_at) VALUES ('1405-1406','2026-09-01','2027-06-30',?)").run(new Date().toISOString());
  const yearId = db.prepare("SELECT id FROM academic_years WHERE label = '1405-1406'").get().id;
  const { id } = exams.createExam(db, {
    title, academicYearId: yearId, durationMinutes, gradeCodes: ['g10'],
    startsAt: new Date(Date.now() - 30 * 60000).toISOString(),
    submissionDeadline: new Date(Date.now() + 10 * HOUR).toISOString(),
    answerKeyPublishAt: new Date(Date.now() + 20 * HOUR).toISOString(),
    resultsPublishAt: new Date(Date.now() + 30 * HOUR).toISOString(),
  }, { actor: 'test' });
  db.prepare('INSERT OR IGNORE INTO subjects (code, label, active) VALUES (?, ?, 1)').run(subjectCode, subjectLabel);
  const sid = db.prepare('SELECT id FROM subjects WHERE code = ?').get(subjectCode).id;
  db.prepare('DELETE FROM exam_subjects WHERE exam_id = ?').run(id);
  db.prepare('INSERT INTO exam_subjects (exam_id, subject_id) VALUES (?, ?)').run(id, sid);
  // برای انتشار باید «فایل سؤالات + تعداد سؤالات» داشته باشد (شیوه‌ی جدید)
  db.prepare(`INSERT OR REPLACE INTO exam_question_files
              (exam_id, original_name, mime_type, size_bytes, sha256, storage_name, uploaded_at)
              VALUES (?, 'q.pdf', 'application/pdf', ?, 'deadbeef', 'q.bin', ?)`)
    .run(id, PDF().length, new Date().toISOString());
  db.prepare('UPDATE exams SET question_count = 5 WHERE id = ?').run(id);
  // و پاسخنامه‌ی رسمی
  db.prepare(`INSERT OR REPLACE INTO answer_keys
              (exam_id, original_name, mime_type, size_bytes, sha256, storage_name, uploaded_at)
              VALUES (?, 'k.pdf', 'application/pdf', ?, 'cafe', 'k.bin', ?)`)
    .run(id, PDF().length, new Date().toISOString());
  exams.transition(db, id, 'published', { actor: 'admin' });
  return id;
}

test('allowedUntil پایانِ مدتِ آزمون است، نه مهلتِ ارسال', () => {
  const base = { starts_at: '2026-10-16T08:00:00.000Z', duration_minutes: 60, submission_deadline: '2026-10-17T08:00:00.000Z' };
  // حالت عادی: شروع + مدت
  assert.equal(exams.allowedUntil(base), '2026-10-16T09:00:00.000Z');
  // اگر مدت از مهلتِ ارسال فراتر رود، به مهلتِ ارسال محدود می‌شود
  const long = { ...base, duration_minutes: 600, submission_deadline: '2026-10-16T10:00:00.000Z' };
  assert.equal(exams.allowedUntil(long), '2026-10-16T10:00:00.000Z');
});

test('admin می‌تواند فایل صوتیِ لیسنینگِ آزمونِ انگلیسی را بارگذاری کند', async () => {
  const s = await start();
  const cookie = await adminCookie(s);
  const id = makeOpenExam(s.db, { title: 'آزمون انگلیسی', subjectCode: 'en', subjectLabel: 'زبان انگلیسی' });

  // جزئیاتِ آزمون باید «انگلیسی بودن» را اعلام کند
  let d = await req(s, 'GET', `/api/admin/exams/${id}`, { cookie });
  assert.equal(d.data.hasEnglish, true, 'باید انگلیسی تشخیص داده شود');
  assert.equal(d.data.hasAudioFile, false);

  const up = await req(s, 'POST', `/api/admin/exams/${id}/audio`, { cookie, form: form(MP3(), 'listening.mp3', 'audio/mpeg') });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.original_name, 'listening.mp3');

  d = await req(s, 'GET', `/api/admin/exams/${id}`, { cookie });
  assert.equal(d.data.hasAudioFile, true);
  assert.equal(d.data.audioFile.original_name, 'listening.mp3');

  // فایل قابل دریافت و بایت‌به‌بایت برابر با اصل است
  const raw = await fetch(`${s.base}/api/admin/exams/${id}/audio`, { headers: { cookie } });
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-type'), /^audio\//);
  assert.ok(Buffer.from(await raw.arrayBuffer()).equals(MP3()));

  // حذف
  const del = await req(s, 'DELETE', `/api/admin/exams/${id}/audio`, { cookie });
  assert.equal(del.status, 200);
  d = await req(s, 'GET', `/api/admin/exams/${id}`, { cookie });
  assert.equal(d.data.hasAudioFile, false);
  await s.close();
});

test('فایل صوتی فقط برای آزمونِ انگلیسی پذیرفته می‌شود', async () => {
  const s = await start();
  const cookie = await adminCookie(s);
  const id = makeOpenExam(s.db, { title: 'آزمون زیست', subjectCode: 'bio', subjectLabel: 'زیست‌شناسی' });
  const d = await req(s, 'GET', `/api/admin/exams/${id}`, { cookie });
  assert.equal(d.data.hasEnglish, false);

  const r = await req(s, 'POST', `/api/admin/exams/${id}/audio`, { cookie, form: form(MP3(), 'l.mp3', 'audio/mpeg') });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'not_english_exam');
  await s.close();
});

test('فایلِ غیرصوتی با پسوندِ mp3 رد می‌شود', async () => {
  const s = await start();
  const cookie = await adminCookie(s);
  const id = makeOpenExam(s.db, { title: 'آزمون انگلیسی', subjectCode: 'en', subjectLabel: 'زبان انگلیسی' });
  const r = await req(s, 'POST', `/api/admin/exams/${id}/audio`, { cookie, form: form(PDF(), 'fake.mp3', 'audio/mpeg') });
  assert.equal(r.status, 415);
  assert.equal(r.data.error.code, 'content_mismatch');
  await s.close();
});

test('دانش‌آموز قبل از شروعِ آزمون به فایل صوتی دسترسی ندارد', async () => {
  const s = await start();
  const admin = await adminCookie(s);
  const id = makeOpenExam(s.db, { title: 'آزمون انگلیسی', subjectCode: 'en', subjectLabel: 'زبان انگلیسی' });
  await req(s, 'POST', `/api/admin/exams/${id}/audio`, { cookie: admin, form: form(MP3(), 'l.mp3', 'audio/mpeg') });
  // آزمون را به آینده برگردان
  s.db.prepare('UPDATE exams SET starts_at = ? WHERE id = ?').run(new Date(Date.now() + 2 * HOUR).toISOString(), id);

  addStudent(s.db, 'stu_l');
  const { cookie } = await login(s, 'stu_l', 'StudentPass1');
  const r = await req(s, 'GET', `/api/student/exams/${id}/audio`, { cookie });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'not_started');
  await s.close();
});

test('دانش‌آموز در فهرستش allowedUntil و hasAudio را می‌بیند و صوت را دریافت می‌کند', async () => {
  const s = await start();
  const admin = await adminCookie(s);
  const id = makeOpenExam(s.db, { title: 'آزمون انگلیسی', subjectCode: 'en', subjectLabel: 'زبان انگلیسی', durationMinutes: 90 });
  const up = await req(s, 'POST', `/api/admin/exams/${id}/audio`, { cookie: admin, form: form(MP3(), 'l.mp3', 'audio/mpeg') });
  assert.equal(up.status, 201, JSON.stringify(up.data));

  addStudent(s.db, 'stu_l');
  const { cookie } = await login(s, 'stu_l', 'StudentPass1');
  const list = await req(s, 'GET', '/api/student/exams', { cookie });
  const row = list.data.exams.find((e) => e.id === id);
  assert.ok(row, 'آزمون در فهرستِ دانش‌آموز است');
  assert.equal(row.hasAudio, true, 'باید نشانِ صوت داشته باشد');
  assert.equal(row.duration_minutes, 90, 'مدت باید در خروجی باشد');
  // allowedUntil باید ≈ شروع + ۹۰ دقیقه باشد، نه مهلتِ ارسال
  const delta = new Date(row.allowedUntil) - new Date(row.starts_at);
  assert.equal(Math.round(delta / 60000), 90, 'allowedUntil باید بر اساسِ مدت باشد');

  const raw = await fetch(`${s.base}/api/student/exams/${id}/audio`, { headers: { cookie } });
  assert.equal(raw.status, 200);
  assert.ok(Buffer.from(await raw.arrayBuffer()).equals(MP3()));
  await s.close();
});
