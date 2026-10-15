'use strict';
// Versioned, transactional schema migrations.
// Each file in migrations/ is applied once, in order, inside a transaction.
// A failed migration rolls back completely and the app refuses to start.
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function migrate(db, log = console) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();

  const applyOne = db.transaction((version, sql) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(version, new Date().toISOString());
  });

  const newly = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    applyOne(version, sql);
    newly.push(version);
    log.info && log.info(`[migrate] applied ${version}`);
  }
  return newly;
}

module.exports = { migrate, MIGRATIONS_DIR };

if (require.main === module) {
  const { config } = require('../config');
  const { openDatabase } = require('./index');
  const db = openDatabase(config.dbPath);
  const done = migrate(db);
  console.log(done.length ? `applied: ${done.join(', ')}` : 'database already up to date');
  db.close();
}
