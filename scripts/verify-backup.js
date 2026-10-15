#!/usr/bin/env node
'use strict';
// Verify a backup file before relying on it: checksum, integrity, schema.
//   node scripts/verify-backup.js backups/db/pepsino-XXXX.sqlite
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const file = process.argv[2];
if (!file) { console.error('usage: verify-backup.js <file.sqlite>'); process.exit(2); }
const sumFile = `${file}.sha256`;
if (fs.existsSync(sumFile)) {
  const expected = fs.readFileSync(sumFile, 'utf8').split(/\s+/)[0];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (expected !== actual) { console.error('CHECKSUM MISMATCH'); process.exit(1); }
  console.log('checksum: ok');
} else {
  console.warn('no .sha256 manifest found');
}
const db = new Database(file, { readonly: true, fileMustExist: true });
const integrity = db.pragma('integrity_check', { simple: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('students','registration_requests','admin_account','audit_log','schema_migrations')").all().map((r) => r.name);
const migrations = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
db.close();
console.log(JSON.stringify({ integrity, tables, migrations }, null, 2));
process.exit(integrity === 'ok' && tables.length === 5 ? 0 : 1);
