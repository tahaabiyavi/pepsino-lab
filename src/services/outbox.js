'use strict';
// Persistent notification outbox with retries.
// - enqueue() is idempotent via dedupe_key (UNIQUE), so retried jobs never
//   create duplicate notifications.
// - Rows are claimed with a lease (status 'sending' + next_attempt_at as lease
//   expiry). A crash mid-send is recovered after the lease expires.
// - Delivery failures never affect business tables.
const LEASE_MS = 5 * 60 * 1000;

function enqueue(db, { dedupeKey, channel, recipient, payload, now = new Date() }) {
  db.prepare(
    `INSERT OR IGNORE INTO notification_outbox
       (dedupe_key, channel, recipient, payload, status, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`
  ).run(dedupeKey, channel, recipient, JSON.stringify(payload), now.toISOString(), now.toISOString());
}

function recoverExpiredLeases(db, now = new Date()) {
  return db.prepare(
    `UPDATE notification_outbox SET status = 'pending'
      WHERE status = 'sending' AND next_attempt_at <= ?`
  ).run(now.toISOString()).changes;
}

/**
 * Process due notifications once.
 * @param {(row:object)=>Promise<void>} sender  throws on delivery failure
 */
async function processDue(db, sender, { now = new Date(), maxAttempts = 8, batch = 20, log = console } = {}) {
  recoverExpiredLeases(db, now);
  const due = db.prepare(
    `SELECT * FROM notification_outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY id LIMIT ?`
  ).all(now.toISOString(), batch);

  let sent = 0, failed = 0;
  for (const row of due) {
    const lease = new Date(now.getTime() + LEASE_MS).toISOString();
    const claimed = db.prepare(
      `UPDATE notification_outbox SET status = 'sending', next_attempt_at = ?
        WHERE id = ? AND status = 'pending'`
    ).run(lease, row.id).changes;
    if (claimed !== 1) continue;

    try {
      await sender(row);
      db.prepare(
        `UPDATE notification_outbox SET status = 'sent', sent_at = ?, last_error = NULL, attempts = attempts + 1
          WHERE id = ?`
      ).run(new Date().toISOString(), row.id);
      sent++;
    } catch (err) {
      const attempts = row.attempts + 1;
      const giveUp = attempts >= maxAttempts;
      const backoffMs = Math.min(30 * 60 * 1000, 30 * 1000 * 2 ** attempts);
      const msg = String(err && err.message ? err.message : err).slice(0, 300);
      db.prepare(
        `UPDATE notification_outbox
            SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?
          WHERE id = ?`
      ).run(giveUp ? 'failed' : 'pending', attempts, msg,
        new Date(now.getTime() + backoffMs).toISOString(), row.id);
      log.warn && log.warn(`[outbox] delivery failed id=${row.id} kind=${row.dedupe_key.split(':')[0]} attempt=${attempts}${giveUp ? ' (gave up; retry from admin)' : ''}: ${msg}`);
      failed++;
    }
  }
  return { processed: due.length, sent, failed };
}

// Admin action: move failed rows back to pending so they are retried.
function retryFailed(db, { now = new Date() } = {}) {
  return db.prepare(
    `UPDATE notification_outbox SET status = 'pending', attempts = 0, next_attempt_at = ?
      WHERE status = 'failed'`
  ).run(now.toISOString()).changes;
}

module.exports = { enqueue, processDue, retryFailed, recoverExpiredLeases, LEASE_MS };
