'use strict';
// SQLite connection management. better-sqlite3 is synchronous, so every
// multi-step business operation runs inside db.transaction(...) and is atomic.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');     // crash-safe, concurrent readers
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (dbPath !== ':memory:') {
    try { fs.chmodSync(dbPath, 0o600); } catch (_) { /* created later by WAL */ }
  }
  return db;
}

module.exports = { openDatabase };
