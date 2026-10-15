'use strict';
// Audit trail. `actor` describes the authenticated channel, e.g.
// 'admin' (shared admin credentials) or 'telegram:<tgUserId>'.
// The shared admin account cannot prove which person acted, so we never
// record a human identity unless a verified identity mechanism exists.
const SECRET_KEYS = /pass|token|secret|hash|cookie|key/i;

function scrub(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(v);
  }
  return out;
}

function recordAudit(db, { actor, action, entityType = null, entityId = null, details = null }, now = new Date()) {
  db.prepare(
    `INSERT INTO audit_log (created_at, actor, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    now.toISOString(),
    String(actor),
    action,
    entityType,
    entityId === null ? null : String(entityId),
    details ? JSON.stringify(scrub(details)) : null
  );
}

module.exports = { recordAudit, scrub };
