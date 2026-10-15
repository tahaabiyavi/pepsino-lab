'use strict';
// Private file backup: complete copy and manifest, missing-file detection,
// and tamper detection on verification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeDb } = require('./helpers');
const { buildExam, addStudent, PDF } = require('./support/fixtures');
const storage = require('../src/files/storage');
const { backupPrivateFiles, verifyFileBackup } = require('../scripts/backup-files');

function setup() {
  const db = makeDb();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepsino-fb-'));
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepsino-bk-'));
  const cleanup = () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  };
  return { db, dataDir, backupDir, cleanup };
}

test('file backup copies every stored file, verifies hashes and writes a manifest', () => {
  const s = setup();
  try {
    const names = [1, 2, 3].map(() => storage.writePrivate(s.dataDir, PDF()));
    const out = backupPrivateFiles(s.db, { dataDir: s.dataDir, backupDir: s.backupDir, now: new Date('2026-10-10T06:00:00Z') });
    assert.equal(out.fileCount, 3);
    assert.equal(out.verification.ok, true);
    assert.equal(out.verification.checked, 3);
    assert.deepEqual(out.missingReferenced, []);
    const manifest = JSON.parse(fs.readFileSync(path.join(out.dest, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files.map((f) => f.path).sort(), [...names].sort());
    for (const n of names) assert.ok(fs.existsSync(path.join(out.dest, n)));
  } finally { s.cleanup(); }
});

test('file backup reports database-referenced files that are missing on disk', () => {
  const s = setup();
  try {
    const exam = buildExam(s.db);
    const student = addStudent(s.db, 'stu_backup');
    const present = storage.writePrivate(s.dataDir, PDF());
    const gone = `uploads/2026-01/${'a'.repeat(48)}.bin`;
    const insert = s.db.prepare(`INSERT INTO pending_uploads (exam_id, student_id, storage_name, original_name, mime_type, size_bytes, sha256, created_at, expires_at)
                                 VALUES (?, ?, ?, 'a.pdf', 'application/pdf', 10, 'x', ?, ?)`);
    insert.run(exam.id, student, present, '2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z');
    insert.run(exam.id, student, gone, '2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z');
    const out = backupPrivateFiles(s.db, { dataDir: s.dataDir, backupDir: s.backupDir, now: new Date('2026-10-10T06:30:00Z') });
    assert.deepEqual(out.missingReferenced, [gone]);
    assert.equal(out.fileCount, 1);
    assert.equal(out.verification.ok, true);
  } finally { s.cleanup(); }
});

test('verification detects a tampered backup copy', () => {
  const s = setup();
  try {
    storage.writePrivate(s.dataDir, Buffer.from('%PDF-1.4 original content'));
    const out = backupPrivateFiles(s.db, { dataDir: s.dataDir, backupDir: s.backupDir, now: new Date('2026-10-10T07:00:00Z') });
    assert.equal(verifyFileBackup(out.dest).ok, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(out.dest, 'manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(out.dest, manifest.files[0].path), 'tampered');
    const check = verifyFileBackup(out.dest);
    assert.equal(check.ok, false);
    assert.deepEqual(check.bad, [manifest.files[0].path]);
  } finally { s.cleanup(); }
});
