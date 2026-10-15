#!/usr/bin/env node
'use strict';
// Consistent online backup of the SQLite database, followed by verification.
// A backup counts as verified only when: the copy opens, PRAGMA integrity_check
// returns "ok", the key tables are readable, and a SHA-256 manifest is written.
//   node scripts/backup.js            (default retention: BACKUP_RETENTION_DAYS=14)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { config } = require('../src/config');
const { openDatabase } = require('../src/db');

async function main() {
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 14);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(config.backupDir, 'db');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `pepsino-${stamp}.sqlite`);

  const src = openDatabase(config.dbPath);
  await src.backup(dest);        // online, consistent snapshot (safe during writes)
  src.close();

  // Verify the copy independently.
  const copy = new Database(dest, { readonly: true, fileMustExist: true });
  const integrity = copy.pragma('integrity_check', { simple: true });
  const counts = {};
  for (const t of ['students', 'registration_requests', 'audit_log']) {
    counts[t] = copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  }
  copy.close();
  if (integrity !== 'ok') {
    fs.unlinkSync(dest);
    throw new Error(`backup integrity check failed: ${integrity}`);
  }

  const sha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  fs.writeFileSync(`${dest}.sha256`, `${sha}  ${path.basename(dest)}\n`, { mode: 0o600 });
  fs.chmodSync(dest, 0o600);
  console.log(JSON.stringify({ ok: true, file: dest, sha256: sha, counts }));

  // Retention: delete only backups older than the window, never the newest.
  const cutoff = Date.now() - retentionDays * 86400e3;
  const files = fs.readdirSync(dir).filter((f) => /^pepsino-.*\.sqlite$/.test(f)).sort();
  for (const f of files.slice(0, -1)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).mtimeMs < cutoff) {
      fs.unlinkSync(full);
      try { fs.unlinkSync(`${full}.sha256`); } catch (_) { /* ignore */ }
    }
  }
}

main().catch((e) => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
