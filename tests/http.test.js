'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, seedAdmin, fakeTelegram, testConfig, SIGNING_KEY, WEBHOOK_SECRET, ADMIN_TG, VALID_REG } = require('./helpers');
const { createApp } = require('../src/app');
const { buildCallbackData } = require('../src/telegram/callbacks');

const silent = { error() {}, warn() {}, info() {} };

async function start(overrides = {}) {
  const db = makeDb();
  seedAdmin(db, 'AdminPass123');
  const config = testConfig(overrides);
  const telegram = fakeTelegram();
  const app = createApp({ db, config, telegram, log: silent });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, telegram, close: () => new Promise((r) => server.close(r)) };
}

const hdr = (cookie, origin = 'http://localhost:3000') => ({
  'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}),
});

async function login(base, username, password) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: hdr(null), body: JSON.stringify({ username, password }),
  });
  const set = r.headers.get('set-cookie') || '';
  const m = /pl_sid=([^;]+)/.exec(set);
  return { status: r.status, cookie: m ? `pl_sid=${m[1]}` : null, body: await r.json() };
}

test('registration API returns 201 without password or hash', async () => {
  const s = await start();
  try {
    const r = await fetch(`${s.base}/api/registrations`, { method: 'POST', headers: hdr(), body: JSON.stringify(VALID_REG) });
    const text = await r.text();
    assert.equal(r.status, 201);
    assert.equal(text.includes('Secret1234'), false);
    assert.equal(text.includes('$2'), false);
    assert.equal(JSON.parse(text).registration.status, 'pending');
  } finally { await s.close(); }
});

test('registration API: duplicate username returns 409', async () => {
  const s = await start();
  try {
    const send = () => fetch(`${s.base}/api/registrations`, { method: 'POST', headers: hdr(), body: JSON.stringify(VALID_REG) });
    assert.equal((await send()).status, 201);
    const r2 = await send();
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).error.code, 'registration_pending');
  } finally { await s.close(); }
});

test('admin endpoints require an admin session (401 anonymous, 403 student)', async () => {
  const s = await start();
  try {
    const anon = await fetch(`${s.base}/api/admin/registrations`);
    assert.equal(anon.status, 401);

    // Create and approve a student through the service, then log in as student.
    const { submitRegistration, decideRegistration } = require('../src/services/registration');
    const r = submitRegistration(s.db, VALID_REG, { rounds: 4 });
    decideRegistration(s.db, { requestId: r.id, action: 'accept', actor: 'admin', source: 'web' });
    const stu = await login(s.base, VALID_REG.username, VALID_REG.password);
    assert.equal(stu.status, 200);
    const forbidden = await fetch(`${s.base}/api/admin/registrations`, { headers: { cookie: stu.cookie } });
    assert.equal(forbidden.status, 403);
    const mine = await fetch(`${s.base}/api/student/me`, { headers: { cookie: stu.cookie } });
    assert.equal(mine.status, 200);
  } finally { await s.close(); }
});

test('admin login grants admin routes; logout revokes', async () => {
  const s = await start();
  try {
    const a = await login(s.base, 'admin', 'AdminPass123');
    assert.equal(a.body.subject.type, 'admin');
    const ok = await fetch(`${s.base}/api/admin/registrations`, { headers: { cookie: a.cookie } });
    assert.equal(ok.status, 200);
    await fetch(`${s.base}/api/auth/logout`, { method: 'POST', headers: hdr(a.cookie) });
    const after = await fetch(`${s.base}/api/admin/registrations`, { headers: { cookie: a.cookie } });
    assert.equal(after.status, 401);
  } finally { await s.close(); }
});

test('cross-site state-changing requests are refused (CSRF origin check)', async () => {
  const s = await start();
  try {
    const a = await login(s.base, 'admin', 'AdminPass123');
    const r = await fetch(`${s.base}/api/admin/registrations/1/decision`, {
      method: 'POST', headers: hdr(a.cookie, 'https://evil.example'), body: JSON.stringify({ action: 'accept' }),
    });
    assert.equal(r.status, 403);
  } finally { await s.close(); }
});

test('input validation returns 400 with field details over HTTP', async () => {
  const s = await start();
  try {
    const r = await fetch(`${s.base}/api/registrations`, { method: 'POST', headers: hdr(), body: JSON.stringify({ username: '' }) });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error.code, 'validation_failed');
    assert.ok(j.error.details.password);
  } finally { await s.close(); }
});

test('Telegram webhook rejects requests without the secret header', async () => {
  const s = await start();
  try {
    const r = await fetch(`${s.base}/api/telegram/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: 1, callback_query: { id: 'x', from: { id: ADMIN_TG }, data: 'reg:1:a:0000000000000000' } }),
    });
    assert.equal(r.status, 401);
  } finally { await s.close(); }
});

test('Telegram webhook with secret processes an authorized Accept end to end', async () => {
  const s = await start();
  try {
    const { submitRegistration } = require('../src/services/registration');
    const reg = submitRegistration(s.db, VALID_REG, { rounds: 4 });
    const data = buildCallbackData(SIGNING_KEY, reg.id, 'accept');
    const body = { update_id: 2, callback_query: { id: 'cbq-1', from: { id: Number(ADMIN_TG) }, data } };
    const headers = { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET };
    const r = await fetch(`${s.base}/api/telegram/webhook`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(r.status, 200);
    // Processing is asynchronous after the 200; poll briefly.
    for (let i = 0; i < 50 && !s.db.prepare("SELECT 1 FROM students WHERE username = ?").get(VALID_REG.username); i++) {
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.equal(s.db.prepare('SELECT status FROM students WHERE username = ?').get(VALID_REG.username).status, 'active');
    // Replay of the same callback is harmless.
    await fetch(`${s.base}/api/telegram/webhook`, { method: 'POST', headers, body: JSON.stringify(body) });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM students').get().n, 1);
  } finally { await s.close(); }
});

test('admin disabling a student revokes their session immediately', async () => {
  const s = await start();
  try {
    const { submitRegistration, decideRegistration } = require('../src/services/registration');
    const reg = submitRegistration(s.db, VALID_REG, { rounds: 4 });
    decideRegistration(s.db, { requestId: reg.id, action: 'accept', actor: 'admin', source: 'web' });
    const stu = await login(s.base, VALID_REG.username, VALID_REG.password);
    const admin = await login(s.base, 'admin', 'AdminPass123');
    const sid = s.db.prepare("SELECT id FROM students WHERE username = ?").get(VALID_REG.username).id;
    const dis = await fetch(`${s.base}/api/admin/students/${sid}/status`, {
      method: 'POST', headers: hdr(admin.cookie), body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(dis.status, 200);
    const check = await fetch(`${s.base}/api/student/me`, { headers: { cookie: stu.cookie } });
    assert.equal(check.status, 401);
    const audit = s.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'student.disabled'").get().n;
    assert.equal(audit, 1);
  } finally { await s.close(); }
});
