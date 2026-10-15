#!/usr/bin/env node
'use strict';
// Create or reset the single administrator account.
// The password is read from a hidden prompt (or from stdin when piped), never
// from argv, so it does not appear in shell history or process listings.
//   npm run set-admin-password
//   printf '%s' "$NEW_PASS" | npm run set-admin-password
const readline = require('readline');
const { config } = require('../src/config');
const { openDatabase } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { hashPassword, checkPasswordPolicy } = require('../src/auth/passwords');
const { recordAudit } = require('../src/services/audit');

function readSecret() {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => (data += c));
      process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      process.stdin.on('error', reject);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {}; // suppress echo
    process.stdout.write('New administrator password: ');
    rl.question('', (ans) => { rl.close(); process.stdout.write('\n'); resolve(ans); });
  });
}

(async () => {
  const db = openDatabase(config.dbPath);
  migrate(db, { info: () => {} });
  const pw = await readSecret();
  const policyError = checkPasswordPolicy(pw);
  if (policyError) {
    console.error(`Rejected: ${policyError}`);
    process.exit(1);
  }
  const now = new Date();
  const hash = hashPassword(pw, config.bcryptRounds);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO admin_account (id, username, password_hash, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash, updated_at = excluded.updated_at`
    ).run(config.adminUsername.toLowerCase(), hash, now.toISOString());
    // Revoke every administrator session so a reset takes effect immediately.
    db.prepare("DELETE FROM sessions WHERE subject_type = 'admin'").run();
    recordAudit(db, { actor: 'cli', action: 'admin.password_set', entityType: 'admin_account', entityId: 1 }, now);
  })();
  console.log(`Administrator "${config.adminUsername.toLowerCase()}" password set. Existing admin sessions were revoked.`);
  db.close();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
