'use strict';
const { config, validateForStartup } = require('./config');
const { openDatabase } = require('./db');
const { migrate } = require('./db/migrate');
const { createApp } = require('./app');
const { TelegramClient } = require('./telegram/client');
const { purgeExpiredSessions } = require('./auth/sessions');
const { tick: schedulerTick } = require('./services/publication');

const log = {
  info: (...a) => console.log(new Date().toISOString(), 'INFO', ...a),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a),
};

function main() {
  const problems = validateForStartup(config);
  if (problems.length) {
    problems.forEach((p) => log.error('[config]', p));
    process.exit(1);
  }

  const db = openDatabase(config.dbPath);
  const applied = migrate(db, log);
  if (applied.length) log.info('[db] migrations applied:', applied.join(', '));

  const telegram = new TelegramClient({ token: config.telegram.botToken });
  const app = createApp({ db, config, telegram, log });

  // Periodic background work. Everything here is restart-safe because the
  // state lives in SQLite, not in memory.
  const timers = [];
  timers.push(setInterval(() => app.locals.runOutbox(), config.outbox.intervalMs));
  timers.push(setInterval(() => purgeExpiredSessions(db), 60 * 60 * 1000));
  // Publication scheduler: closes windows, releases answer keys, publishes results.
  // Idempotent and restart-safe; overdue work is picked up on the next tick.
  const runScheduler = () => {
    try {
      const out = schedulerTick(db, new Date(), { dataDir: config.dataDir });
      if (out.closed.length || out.answerKeys.length || out.results.length) log.info('[scheduler]', JSON.stringify(out));
    } catch (e) { log.error('[scheduler] tick failed', e.message); }
  };
  timers.push(setInterval(runScheduler, 60 * 1000));
  runScheduler();
  timers.push(setInterval(() => {
    // Crude but effective: keep the WAL file small.
    try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (_) { /* ignore */ }
  }, 10 * 60 * 1000));

  const server = app.listen(config.port, config.host, () => {
    log.info(`[http] listening on ${config.host}:${config.port} (public: ${config.publicOrigin})`);
    if (!telegram.enabled) log.warn('[telegram] TELEGRAM_BOT_TOKEN not set; notifications queued only');
    app.locals.runOutbox();
  });

  const shutdown = (sig) => {
    log.info(`[proc] ${sig} received, shutting down`);
    timers.forEach(clearInterval);
    server.close(() => {
      try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) { /* ignore */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
