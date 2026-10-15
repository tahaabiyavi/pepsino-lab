'use strict';
// Shared HTTP and data fixtures for route-level tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { makeDb, seedAdmin, fakeTelegram, testConfig } = require('../helpers');
const { createApp } = require('../../src/app');
const exams = require('../../src/services/exams');
const { hashPassword } = require('../../src/auth/passwords');
const storage = require('../../src/files/storage');

const ORIGIN = 'http://localhost:3000';
const HOUR = 3600e3;
const silent = { error() {}, warn() {}, info() {} };
const PDF = () => Buffer.from(`%PDF-1.4\n% ${crypto.randomBytes(8).toString('hex')}\n%%EOF\n`);

async function start(overrides = {}) {
  const db = makeDb();
  seedAdmin(db, 'AdminPass123');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepsino-t-'));
  const config = testConfig({ dataDir, appealWindowDays: 7, ...overrides });
  const app = createApp({ db, config, telegram: fakeTelegram(), log: silent });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db, base, dataDir, config,
    close: () => new Promise((r) => server.close(() => { fs.rmSync(dataDir, { recursive: true, force: true }); r(); })),
  };
}

async function req(s, method, url, { cookie, json, form } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  let body;
  if (form) body = form;
  else if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const r = await fetch(s.base + url, { method, headers, body });
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
  return (await login(s, 'admin', 'AdminPass123')).cookie;
}

function addStudent(db, username, password = 'StudentPass1', gradeCode = 'g10') {
  const grade = db.prepare('SELECT id FROM grades WHERE code = ?').get(gradeCode).id;
  const field = db.prepare("SELECT id FROM academic_fields WHERE code = 'math_physics'").get().id;
  const now = new Date().toISOString();
  return Number(db.prepare(
    `INSERT INTO students (username, password_hash, full_name, grade_id, field_id, status, created_at, updated_at, approved_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).run(username, hashPassword(password, 4), `دانش‌آموز ${username}`, grade, field, now, now, now).lastInsertRowid);
}

function subjectId(db, code, label) {
  db.prepare('INSERT OR IGNORE INTO subjects (code, label) VALUES (?, ?)').run(code, label);
  return db.prepare('SELECT id FROM subjects WHERE code = ?').get(code).id;
}

/** Exam with two questions in two subjects (math, physics), grade g10, and an answer key. */
function buildExam(db, { title = 'آزمون تست' } = {}) {
  const now = new Date();
  db.prepare("INSERT OR IGNORE INTO academic_years (label, starts_on, ends_on, created_at) VALUES ('1405-1406','2026-09-01','2027-06-30',?)").run(now.toISOString());
  const academicYearId = db.prepare("SELECT id FROM academic_years WHERE label = '1405-1406'").get().id;
  const math = subjectId(db, 'math', 'ریاضی');
  const physics = subjectId(db, 'physics', 'فیزیک');
  const day = 24 * HOUR;
  const future = (ms) => new Date(now.getTime() + ms).toISOString();
  const { id } = exams.createExam(db, {
    title, academicYearId, durationMinutes: 60, gradeCodes: ['g10'],
    startsAt: future(day), submissionDeadline: future(day + 2 * HOUR),
    answerKeyPublishAt: future(2 * day), resultsPublishAt: future(3 * day),
  }, { now });
  db.prepare("INSERT OR IGNORE INTO topics (subject_id, label) VALUES (?, 'مبحث')").run(math);
  db.prepare("INSERT OR IGNORE INTO topics (subject_id, label) VALUES (?, 'مبحث')").run(physics);
  const topicOf = (sj) => db.prepare('SELECT id FROM topics WHERE subject_id = ? AND label = ?').get(sj, 'مبحث').id;
  exams.addQuestion(db, id, { body: 'سوال ریاضی', maxMark: '1', subjectId: math, topicIds: [topicOf(math)], position: 1 }, { now });
  exams.addQuestion(db, id, { body: 'سوال فیزیک', maxMark: '1', subjectId: physics, topicIds: [topicOf(physics)], position: 2 }, { now });
  return { id, academicYearId, questionIds: db.prepare('SELECT id FROM questions WHERE exam_id = ? ORDER BY position').all(id).map((r) => r.id) };
}

function attachKey(s, examId) {
  const buf = PDF();
  const meta = storage.validateUpload({ buffer: buf, originalName: 'key.pdf' });
  const name = storage.writePrivate(s.dataDir, buf);
  s.db.prepare(`INSERT INTO answer_keys (exam_id, original_name, mime_type, size_bytes, sha256, storage_name, uploaded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(examId, meta.originalName, meta.mimeType, meta.sizeBytes, meta.sha256, name, new Date().toISOString());
}

function setStatus(db, examId, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE exams SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), examId);
}

const iso = (ms) => new Date(Date.now() + ms).toISOString();

module.exports = { start, req, login, adminCookie, addStudent, buildExam, attachKey, setStatus, iso, PDF, subjectId, ORIGIN, HOUR, silent };
