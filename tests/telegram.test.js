'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, fakeTelegram, SIGNING_KEY, ADMIN_TG, OTHER_TG, VALID_REG } = require('./helpers');
const { submitRegistration } = require('../src/services/registration');
const { processDue, enqueue, recoverExpiredLeases } = require('../src/services/outbox');
const { buildCallbackData, parseCallbackData, handleRegistrationCallback } = require('../src/telegram/callbacks');
const { buildAdminDelivery } = require('../src/telegram/notifier');

const silent = { error() {}, warn() {}, info() {} };
const deps = (tg, extra = {}) => ({
  allowedIds: [ADMIN_TG],
  signingKey: SIGNING_KEY,
  client: tg,
  log: silent,
  ...extra,
});
let cbSeq = 0;
const cb = (from, data, id) => ({ id: id || `cb-${++cbSeq}`, from: { id: Number(from) }, data });
const newPending = (db, username = VALID_REG.username) =>
  submitRegistration(db, { ...VALID_REG, username }, { rounds: 4, adminChatId: '-100123' });

test('callback data round-trips and is signed', () => {
  const data = buildCallbackData(SIGNING_KEY, 42, 'accept');
  assert.deepEqual(parseCallbackData(SIGNING_KEY, data), { requestId: 42, action: 'accept' });
  assert.equal(parseCallbackData('another-key-another-key-another-key', data), null, 'wrong key rejected');
});

test('tampered callback data (changed request id) is rejected', () => {
  const data = buildCallbackData(SIGNING_KEY, 42, 'reject');
  const forged = data.replace(/^reg:42:/, 'reg:43:');
  assert.equal(parseCallbackData(SIGNING_KEY, forged), null);
});

test('callback from a non-allowlisted Telegram user changes nothing', async () => {
  const db = makeDb();
  const r = newPending(db);
  const tg = fakeTelegram();
  const data = buildCallbackData(SIGNING_KEY, r.id, 'accept');
  const outcome = await handleRegistrationCallback(db, cb(OTHER_TG, data), deps(tg));
  assert.equal(outcome, 'unauthorized');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM registration_requests WHERE id = ?').get(r.id).status, 'pending');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'telegram.unauthorized_callback'").get());
});

test('authorized Accept activates the student', async () => {
  const db = makeDb();
  const r = newPending(db);
  const tg = fakeTelegram();
  const outcome = await handleRegistrationCallback(db, cb(ADMIN_TG, buildCallbackData(SIGNING_KEY, r.id, 'accept')), deps(tg));
  assert.equal(outcome, 'accepted');
  assert.equal(db.prepare('SELECT status FROM students WHERE username = ?').get(VALID_REG.username).status, 'active');
  assert.equal(tg.answers.length, 1);
});

test('replayed callback_query_id is ignored', async () => {
  const db = makeDb();
  const r = newPending(db);
  const tg = fakeTelegram();
  const c = cb(ADMIN_TG, buildCallbackData(SIGNING_KEY, r.id, 'accept'), 'fixed-id');
  assert.equal(await handleRegistrationCallback(db, c, deps(tg)), 'accepted');
  assert.equal(await handleRegistrationCallback(db, c, deps(tg)), 'duplicate');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 1);
});

test('new callback repeating an already-applied Accept is idempotent', async () => {
  const db = makeDb();
  const r = newPending(db);
  const tg = fakeTelegram();
  const data = buildCallbackData(SIGNING_KEY, r.id, 'accept');
  await handleRegistrationCallback(db, cb(ADMIN_TG, data), deps(tg));
  const outcome = await handleRegistrationCallback(db, cb(ADMIN_TG, data), deps(tg));
  assert.equal(outcome, 'already_applied');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 1);
});

test('Reject via Telegram then resubmission works', async () => {
  const db = makeDb();
  const r = newPending(db);
  const tg = fakeTelegram();
  assert.equal(await handleRegistrationCallback(db, cb(ADMIN_TG, buildCallbackData(SIGNING_KEY, r.id, 'reject')), deps(tg)), 'rejected');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 0);
  const r2 = newPending(db);
  assert.equal(r2.status, 'pending');
});

test('Accept after Reject reports already_decided and changes nothing', async () => {
  const db = makeDb();
  const r = newPending(db);
  const tg = fakeTelegram();
  await handleRegistrationCallback(db, cb(ADMIN_TG, buildCallbackData(SIGNING_KEY, r.id, 'reject')), deps(tg));
  const outcome = await handleRegistrationCallback(db, cb(ADMIN_TG, buildCallbackData(SIGNING_KEY, r.id, 'accept')), deps(tg));
  assert.equal(outcome, 'already_decided');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 0);
});

test('forged signature from an authorized user is rejected', async () => {
  const db = makeDb();
  const r = newPending(db);
  const tg = fakeTelegram();
  const outcome = await handleRegistrationCallback(db, cb(ADMIN_TG, `reg:${r.id}:a:AAAAAAAAAAAAAAAA`), deps(tg));
  assert.equal(outcome, 'invalid_signature');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 0);
});

test('outbox: Telegram outage keeps the registration and retries later', async () => {
  const db = makeDb();
  const r = newPending(db);
  const failing = async () => { throw new Error('telegram sendMessage failed: 502'); };
  const t0 = new Date(); // relative to the real clock: rows are created 'now'
  let res = await processDue(db, failing, { now: t0, maxAttempts: 3, log: silent });
  assert.equal(res.failed, 1);
  // Registration itself is untouched.
  assert.equal(db.prepare('SELECT status FROM registration_requests WHERE id = ?').get(r.id).status, 'pending');
  const row = db.prepare('SELECT * FROM notification_outbox').get();
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  // Not yet due: nothing processed.
  res = await processDue(db, failing, { now: t0, maxAttempts: 3, log: silent });
  assert.equal(res.processed, 0);
  // Due later and delivered.
  const sent = [];
  res = await processDue(db, async (x) => { sent.push(x.id); }, { now: new Date(t0.getTime() + 3600e3), maxAttempts: 3, log: silent });
  assert.equal(res.sent, 1);
  assert.equal(db.prepare('SELECT status FROM notification_outbox').get().status, 'sent');
});

test('outbox: gives up after max attempts and marks failed (retryable)', async () => {
  const db = makeDb();
  newPending(db);
  const failing = async () => { throw new Error('down'); };
  let now = new Date();
  for (let i = 0; i < 3; i++) {
    await processDue(db, failing, { now, maxAttempts: 3, log: silent });
    now = new Date(now.getTime() + 48 * 3600e3);
  }
  assert.equal(db.prepare('SELECT status FROM notification_outbox').get().status, 'failed');
});

test('outbox: duplicate enqueue for the same event creates one notification', () => {
  const db = makeDb();
  const r = newPending(db);
  enqueue(db, { dedupeKey: `registration:new:${r.id}`, channel: 'telegram_admin', recipient: 'x', payload: {} });
  enqueue(db, { dedupeKey: `registration:new:${r.id}`, channel: 'telegram_admin', recipient: 'x', payload: {} });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n, 1);
});

test('outbox: rows stranded in "sending" after a crash are recovered', () => {
  const db = makeDb();
  newPending(db);
  db.prepare("UPDATE notification_outbox SET status = 'sending', next_attempt_at = '2026-10-10T10:00:00Z'").run();
  assert.equal(recoverExpiredLeases(db, new Date('2026-10-10T11:00:00Z')), 1);
  assert.equal(db.prepare('SELECT status FROM notification_outbox').get().status, 'pending');
});

test('admin notification payload carries signed Accept/Reject buttons', async () => {
  const db = makeDb();
  newPending(db);
  const row = db.prepare('SELECT * FROM notification_outbox').get();
  const tg = fakeTelegram();
  await buildAdminDelivery(row, { client: tg, signingKey: SIGNING_KEY });
  const kb = tg.sent[0].markup.inline_keyboard[0];
  assert.equal(kb.length, 2);
  assert.ok(parseCallbackData(SIGNING_KEY, kb[0].callback_data));
  assert.ok(parseCallbackData(SIGNING_KEY, kb[1].callback_data));
  assert.equal(tg.sent[0].text.includes('Secret1234'), false, 'password never sent to Telegram');
});
