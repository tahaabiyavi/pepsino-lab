'use strict';
// Telegram admin actions (Accept / Reject) for registration requests.
//
// Security model:
//  1. Callback data is signed (HMAC) so payloads cannot be forged or altered.
//  2. A signature alone is NOT authorization. The Telegram user ID must be in
//     TELEGRAM_ADMIN_IDS. Individual identities are configured explicitly.
//  3. Each callback_query_id is recorded once (UNIQUE). Replays and repeats are
//     answered without changing state.
//  4. The decision itself is idempotent (see services/registration.js).
const crypto = require('crypto');
const { decideRegistration } = require('../services/registration');
const { AppError } = require('../services/errors');
const { recordAudit } = require('../services/audit');

const ACTIONS = { a: 'accept', r: 'reject' };

function sign(key, requestId, code) {
  return crypto.createHmac('sha256', key).update(`reg:${requestId}:${code}`).digest('base64url').slice(0, 16);
}

function buildCallbackData(key, requestId, action) {
  const code = action === 'accept' ? 'a' : 'r';
  return `reg:${requestId}:${code}:${sign(key, requestId, code)}`;
}

function parseCallbackData(key, data) {
  const m = /^reg:(\d{1,12}):([ar]):([A-Za-z0-9_-]{16})$/.exec(String(data || ''));
  if (!m) return null;
  const requestId = Number(m[1]);
  const expected = sign(key, requestId, m[2]);
  const a = Buffer.from(expected), b = Buffer.from(m[3]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { requestId, action: ACTIONS[m[2]] };
}

function isAuthorizedTelegramUser(allowedIds, tgUserId) {
  return allowedIds.includes(String(tgUserId));
}

/**
 * Handle one callback_query update. Returns the outcome string.
 */
async function handleRegistrationCallback(db, cb, deps) {
  const { allowedIds, signingKey, client, now = new Date(), log = console } = deps;
  const tgUserId = String(cb.from && cb.from.id);
  const cbId = String(cb.id);
  const nowIso = now.toISOString();

  const answer = async (text) => {
    try { await client.answerCallbackQuery(cbId, text); } catch (e) { log.warn && log.warn('[telegram] answerCallbackQuery failed'); }
  };

  // Claim the callback first. A duplicate or replay stops here.
  const claim = (outcome, targetId = null) => {
    try {
      db.prepare(
        `INSERT INTO telegram_callbacks (callback_query_id, tg_user_id, action, target_id, outcome, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(cbId, tgUserId, String(cb.data || '').slice(0, 64), targetId, outcome, nowIso);
      return true;
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return false;
      throw e;
    }
  };

  if (!isAuthorizedTelegramUser(allowedIds, tgUserId)) {
    claim('unauthorized');
    recordAudit(db, { actor: `telegram:${tgUserId}`, action: 'telegram.unauthorized_callback', details: { data: 'redacted' } }, now);
    await answer('شما اجازه‌ی این عملیات را ندارید.');
    return 'unauthorized';
  }

  const parsed = parseCallbackData(signingKey, cb.data);
  if (!parsed) {
    claim('invalid_signature');
    await answer('داده‌ی نامعتبر است.');
    return 'invalid_signature';
  }

  if (!claim('processing', parsed.requestId)) {
    await answer('این درخواست قبلاً پردازش شده است.');
    return 'duplicate';
  }

  let outcome;
  try {
    const r = decideRegistration(db, {
      requestId: parsed.requestId,
      action: parsed.action,
      actor: `telegram:${tgUserId}`,
      source: 'telegram',
    }, { now });
    outcome = r.alreadyApplied ? 'already_applied' : parsed.action === 'accept' ? 'accepted' : 'rejected';
    db.prepare('UPDATE telegram_callbacks SET outcome = ? WHERE callback_query_id = ?').run(outcome, cbId);
    await answer(r.alreadyApplied ? 'قبلاً همین تصمیم ثبت شده است.' : (parsed.action === 'accept' ? 'حساب تأیید شد.' : 'درخواست رد شد.'));
  } catch (err) {
    if (err instanceof AppError) {
      outcome = err.code;
      db.prepare('UPDATE telegram_callbacks SET outcome = ? WHERE callback_query_id = ?').run(outcome, cbId);
      await answer(err.message);
    } else {
      db.prepare('UPDATE telegram_callbacks SET outcome = ? WHERE callback_query_id = ?').run('internal_error', cbId);
      log.error && log.error('[telegram] callback failed', err && err.stack);
      await answer('خطای داخلی؛ دوباره تلاش کنید.');
      return 'internal_error';
    }
  }
  return outcome;
}

module.exports = {
  buildCallbackData,
  parseCallbackData,
  isAuthorizedTelegramUser,
  handleRegistrationCallback,
};
