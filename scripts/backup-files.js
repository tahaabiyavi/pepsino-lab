#!/usr/bin/env node
'use strict';
// Backup of private answer-sheet and answer-key files (DATA_DIR/private).
// The database backup does NOT include these files; run this alongside it.
// Each copy is hashed and compared with its source, a manifest is written,
// and the manifest is re-verified from disk. Files referenced by the database
// but missing on disk are reported and make the run fail.
//   node scripts/backup-files.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listStoredFiles } = require('../src/files/storage');

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function referencedStorageNames(db) {
  const names = new Set();
  for (const sql of [
    'SELECT storage_name FROM answer_keys',
    'SELECT storage_name FROM submission_files',
    'SELECT storage_name FROM pending_uploads',
  ]) {
    for (const r of db.prepare(sql).all()) names.add(r.storage_name);
  }
  return names;
}

/** Copy every stored file into backupDir/files/<stamp>/ and verify the result. */
function backupPrivateFiles(db, { dataDir, backupDir, now = new Date() }) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, 'files', stamp);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });

  const stored = listStoredFiles(dataDir);
  const onDisk = new Set(stored.map((f) => f.storageName));
  const entries = [];
  for (const f of stored) {
    const target = path.join(dest, f.storageName);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(f.full, target, fs.constants.COPYFILE_EXCL);
    const srcHash = sha256(f.full);
    const dstHash = sha256(target);
    if (srcHash !== dstHash) throw new Error(`copy mismatch for ${f.storageName}`);
    entries.push({ path: f.storageName, sha256: dstHash, size: fs.statSync(target).size });
  }
  const missingReferenced = [...referencedStorageNames(db)].filter((n) => !onDisk.has(n)).sort();
  const manifest = {
    createdAt: now.toISOString(),
    fileCount: entries.length,
    files: entries,
    missingReferenced,
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const verification = verifyFileBackup(dest);
  return { dest, fileCount: entries.length, missingReferenced, verification };
}

/** Re-read the manifest and re-hash every file in the backup. */
function verifyFileBackup(dest) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
  const bad = [];
  for (const e of manifest.files) {
    const full = path.join(dest, e.path);
    if (!fs.existsSync(full) || sha256(full) !== e.sha256) bad.push(e.path);
  }
  return { ok: bad.length === 0, checked: manifest.files.length, bad };
}

module.exports = { backupPrivateFiles, verifyFileBackup, referencedStorageNames };

if (require.main === module) {
  const { config } = require('../src/config');
  const { openDatabase } = require('../src/db');
  const db = openDatabase(config.dbPath);
  try {
    const out = backupPrivateFiles(db, { dataDir: config.dataDir, backupDir: config.backupDir });
    console.log(JSON.stringify({ ok: out.verification.ok && out.missingReferenced.length === 0, ...out }, null, 2));
    process.exitCode = out.verification.ok && out.missingReferenced.length === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}
