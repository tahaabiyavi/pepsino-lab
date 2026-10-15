'use strict';
const { openDatabase } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { hashPassword } = require('../src/auth/passwords');

const SIGNING_KEY = 'test-signing-key-that-is-long-enough-123456';
const WEBHOOK_SECRET = 'test-webhook-secret';
const ADMIN_TG = '111111';
const OTHER_TG = '999999';

function makeDb() {
  const db = openDatabase(':memory:');
  migrate(db, { info: () => {} });
  return db;
}

function seedAdmin(db, password = 'AdminPass123') {
  db.prepare('INSERT INTO admin_account (id, username, password_hash, updated_at) VALUES (1, ?, ?, ?)')
    .run('admin', hashPassword(password, 4), new Date().toISOString());
}

function fakeTelegram() {
  const t = {
    enabled: true,
    sent: [],
    answers: [],
    edits: [],
    async sendMessage(chatId, text, markup) { t.sent.push({ chatId, text, markup }); return { message_id: t.sent.length }; },
    async answerCallbackQuery(id, text) { t.answers.push({ id, text }); return true; },
    async editMessageText(chatId, messageId, text) { t.edits.push({ chatId, messageId, text }); return true; },
    failNext: 0,
  };
  return t;
}

function testConfig(overrides = {}) {
  return {
    isProd: false,
    publicOrigin: 'http://localhost:3000',
    trustProxy: 0,
    sessionTtlHours: 8,
    sessionAbsoluteHours: 24,
    bcryptRounds: 4,
    adminUsername: 'admin',
    dbPath: ':memory:',
    telegram: {
      botToken: 'test-token',
      adminIds: [ADMIN_TG],
      adminChatId: '-100123',
      webhookSecret: WEBHOOK_SECRET,
      callbackSigningKey: SIGNING_KEY,
    },
    outbox: { intervalMs: 1e9, maxAttempts: 3 },
    ...overrides,
  };
}

const VALID_REG = {
  fullName: 'علی تست',
  username: 'ali_test',
  password: 'Secret1234',
  gradeCode: 'g10',
  fieldCode: 'math_physics',
};

module.exports = { makeDb, seedAdmin, fakeTelegram, testConfig, SIGNING_KEY, WEBHOOK_SECRET, ADMIN_TG, OTHER_TG, VALID_REG };
