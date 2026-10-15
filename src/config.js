'use strict';
// Central configuration. All secrets come from environment variables.
// Nothing secret is hardcoded or committed.
const path = require('path');

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function list(name) {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const isProd = process.env.NODE_ENV === 'production';

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd,
  port: int('PORT', 3000),
  host: process.env.HOST || '127.0.0.1',       // reverse proxy talks to this
  publicOrigin: process.env.PUBLIC_ORIGIN || 'http://localhost:3000',
  trustProxy: int('TRUST_PROXY', 1),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pepsino.sqlite'),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  sessionTtlHours: int('SESSION_TTL_HOURS', 8),
  sessionAbsoluteHours: int('SESSION_ABSOLUTE_HOURS', 24),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  bcryptRounds: int('BCRYPT_ROUNDS', 12),
  appealWindowDays: int('APPEAL_WINDOW_DAYS', 7),
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    adminIds: list('TELEGRAM_ADMIN_IDS'),        // allowlist of Telegram user IDs
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    callbackSigningKey: process.env.TELEGRAM_CALLBACK_KEY || '',
  },
  outbox: {
    intervalMs: int('OUTBOX_INTERVAL_MS', 15000),
    maxAttempts: int('OUTBOX_MAX_ATTEMPTS', 8),
  },
  backupDir: process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'),
};

function validateForStartup(cfg = config) {
  const problems = [];
  if (cfg.isProd) {
    if (!cfg.publicOrigin.startsWith('https://')) problems.push('PUBLIC_ORIGIN must be https in production');
    // تلگرام اختیاری است. بدون TELEGRAM_BOT_TOKEN مسیر وب‌هوک ۴۰۴ می‌دهد و امضای دکمه‌های
    // تأیید/رد بی‌معناست؛ بنابراین این دو راز فقط هنگامی الزامی‌اند که بات پیکربندی شده باشد.
    if (cfg.telegram.botToken) {
      if (!cfg.telegram.webhookSecret) {
        problems.push('TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_BOT_TOKEN is set');
      }
      if (!cfg.telegram.callbackSigningKey || cfg.telegram.callbackSigningKey.length < 32) {
        problems.push('TELEGRAM_CALLBACK_KEY must be set (>= 32 chars) when TELEGRAM_BOT_TOKEN is set');
      }
    }
  }
  if (cfg.telegram.botToken && cfg.telegram.adminIds.length === 0) {
    problems.push('TELEGRAM_ADMIN_IDS must list at least one authorized Telegram user ID');
  }
  return problems;
}

module.exports = { config, validateForStartup };
