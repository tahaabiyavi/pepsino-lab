'use strict';
// Express application factory. Dependencies are injected so tests can run
// against an in-memory database and a fake Telegram client.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { COOKIE_NAME, revokeSession, revokeStudentSessions } = require('./auth/sessions');
const { attachSession, requireRole, csrfOriginGuard, errorHandler } = require('./middleware/security');
const { submitRegistration, decideRegistration, listRegistrations } = require('./services/registration');
const { login } = require('./services/login');
const { processDue, retryFailed } = require('./services/outbox');
const { recordAudit } = require('./services/audit');
const { AppError, badRequest, notFound } = require('./services/errors');
const { handleRegistrationCallback, isAuthorizedTelegramUser } = require('./telegram/callbacks');
const { buildAdminDelivery, formatRegistrationMessage } = require('./telegram/notifier');
const { buildCallbackData } = require('./telegram/callbacks');
const { mountExamRoutes } = require('./routes/examRoutes');
const { mountResultRoutes } = require('./routes/resultRoutes');
const { consumePasswordReset, requestPasswordHelp } = require('./services/accounts');
const strategic = require('./services/strategic');
const home = require('./services/home');
const settings = require('./services/settings');
const jalali = require('./services/jalali');
const practice = require('./services/practice');

/** ورودیِ اختیاریِ عددی از query-string (مثل سال/ماه شمسی). */
function parseIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}


function createApp({ db, config, telegram, log = console, logger = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  // Several browser security headers (upgrade-insecure-requests, COOP,
  // Origin-Agent-Cluster) only make sense — and are only honored by
  // browsers — when the app is actually served over HTTPS. PUBLIC_ORIGIN
  // is the single source of truth for that: when it's https:// (a real
  // domain behind TLS), these stay on. When it's http:// (e.g. a bare-IP
  // test deployment with no domain/SSL yet), they're switched off so the
  // browser doesn't silently rewrite http:// asset/API requests to
  // https:// and break them with ERR_SSL_PROTOCOL_ERROR. No manual
  // toggling needed when the domain + SSL are added later — it follows
  // PUBLIC_ORIGIN automatically.
  const servedOverHttps = config.publicOrigin.startsWith('https://');

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        // فایلِ لیسنینگ می‌تواند پیوندی به یک میزبانِ خارجی باشد؛
        // بدون این دو خط، مرورگر آن را مسدود می‌کند.
        'media-src': ["'self'", 'https:', 'blob:', 'data:'],
        'frame-src': ["'self'", 'https:'],
        'style-src': ["'self'", "'unsafe-inline'"],
        'script-src': ["'self'"],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        ...(servedOverHttps ? {} : { 'upgrade-insecure-requests': null }),
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: servedOverHttps ? undefined : false,
    originAgentCluster: servedOverHttps,
  }));
  app.use(express.json({ limit: '32kb' }));          // ordinary JSON bodies are small
  app.use(cookieParser());
  app.use(attachSession(db, config));
  app.use(csrfOriginGuard(config.publicOrigin));

  const limiter = (windowMin, limit) => rateLimit({
    windowMs: windowMin * 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'تعداد درخواست‌ها زیاد است؛ کمی بعد تلاش کنید' } },
  });

  // ---- health & static --------------------------------------------------
  app.get('/healthz', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true });
    } catch (_) {
      res.status(503).json({ ok: false });
    }
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: 'index.html',
    dotfiles: 'deny',
    extensions: ['html'],
  }));

  // ---- public ----------------------------------------------------------
  app.get('/api/meta/options', (_req, res) => {
    // فقط نام و کد — بدون نمایش شناسهٔ عددی در UI
    res.json({
      grades: db.prepare('SELECT code, label FROM grades WHERE active = 1 ORDER BY sort_order').all(),
      fields: db.prepare('SELECT code, label FROM academic_fields WHERE active = 1 ORDER BY sort_order').all(),
      subjects: db.prepare('SELECT id, code, label FROM subjects WHERE active = 1 ORDER BY label').all(),
      academicYears: db.prepare('SELECT id, label FROM academic_years ORDER BY id DESC').all(),
      leaderboardTopN: (db.prepare("SELECT value FROM app_settings WHERE key = 'leaderboard_top_n'").get() || { value: '5' }).value,
    });
  });

  app.post('/api/registrations', limiter(60, 10), (req, res, next) => {
    try {
      const r = submitRegistration(db, req.body || {}, {
        rounds: config.bcryptRounds,
        adminChatId: config.telegram.adminChatId,
      });
      // The response never contains the password or its hash.
      res.status(201).json({
        registration: { id: r.id, status: r.status, username: r.username },
        message: 'درخواست شما ثبت شد و پس از تأیید مدیر فعال می‌شود.',
      });
      triggerOutbox();
    } catch (e) { next(e); }
  });

  app.post('/api/auth/login', limiter(15, 20), (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      const out = login(db, { username, password, userAgent: req.get('user-agent') }, {
        sessionTtlHours: config.sessionTtlHours,
        sessionAbsoluteHours: config.sessionAbsoluteHours,
      });
      res.cookie(COOKIE_NAME, out.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.isProd,
        path: '/',
        maxAge: config.sessionAbsoluteHours * 3600 * 1000,
      });
      res.json({ subject: out.subject });
    } catch (e) { next(e); }
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionToken) revokeSession(db, req.sessionToken);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    res.json({ subject: req.auth || null });
  });

  // Password help: generic response; the admin is notified through the outbox.
  app.post('/api/auth/password-help', limiter(60, 5), (req, res, next) => {
    try {
      const out = requestPasswordHelp(db, String((req.body && req.body.username) || ''), { adminChatId: config.telegram.adminChatId });
      triggerOutbox();
      res.json(out);
    } catch (e) { next(e); }
  });

  // Reset with a one-time token issued by the administrator.
  app.post('/api/auth/password-reset', limiter(15, 10), (req, res, next) => {
    try {
      const b = req.body || {};
      res.json(consumePasswordReset(db, { username: b.username, token: b.token, newPassword: b.newPassword }, { rounds: config.bcryptRounds }));
    } catch (e) { next(e); }
  });

  // ---- student ---------------------------------------------------------
  app.get('/api/student/me', requireRole('student'), (req, res) => {
    const s = db.prepare(
      `SELECT s.id, s.username, s.full_name, g.label AS grade, f.label AS field, s.status
         FROM students s JOIN grades g ON g.id = s.grade_id JOIN academic_fields f ON f.id = s.field_id
        WHERE s.id = ?`
    ).get(req.auth.id);
    res.json({ student: s });
  });


  // ---- برنامه راهبردی (دانش‌آموز) ------------------------------------
  app.get('/api/student/strategic-plan', requireRole('student'), (req, res) => {
    const phases = strategic.listPhasesForStudent(db, req.auth.id);
    res.json({ phases });
  });

  // ---- صفحه‌ی اصلیِ پنل دانش‌آموز (یک درخواست، همه‌چیز) ---------------
  // شامل: متن‌های قابل ویرایش، آمار، مرحله‌ی جاری و شمارش معکوس،
  // برنامه راهبردی، آزمون‌های پیش‌رو/منقضی، مجموعه‌های تمرین،
  // رتبه‌بندی و تقویم شمسی.
  app.get('/api/student/home', requireRole('student'), (req, res, next) => {
    try {
      res.json(home.homeForStudent(db, req.auth.id));
    } catch (e) { next(e); }
  });

  app.get('/api/student/calendar', requireRole('student'), (req, res, next) => {
    try {
      const jy = parseIntOrNull(req.query.jy);
      const jm = parseIntOrNull(req.query.jm);
      res.json({ calendar: home.calendar(db, req.auth.id, { jy, jm }) });
    } catch (e) { next(e); }
  });

  app.get('/api/student/plan/table', requireRole('student'), (req, res, next) => {
    try {
      res.json({ rows: home.planTable(db, req.auth.id) });
    } catch (e) { next(e); }
  });

  // ---- لیدربورد دانش‌آموز --------------------------------------------
  app.get('/api/student/leaderboard', requireRole('student'), (req, res) => {
    const topN = Number((db.prepare("SELECT value FROM app_settings WHERE key = 'leaderboard_top_n'").get() || { value: '5' }).value) || 5;
    // رتبه‌بندی بر اساس مجموع نمرات منتشرشده
    const rows = db.prepare(`
      SELECT st.id AS student_id, st.full_name, g.label AS grade,
             COALESCE(SUM(qs.quarters), 0) AS total_quarters
        FROM students st
        JOIN grades g ON g.id = st.grade_id
        LEFT JOIN submissions s ON s.student_id = st.id AND s.status = 'submitted'
        LEFT JOIN exams e ON e.id = s.exam_id AND e.results_published_at IS NOT NULL
        LEFT JOIN grading_assignments a ON a.submission_id = s.id AND a.state = 'completed'
        LEFT JOIN question_scores qs ON qs.assignment_id = a.id
       WHERE st.status = 'active'
       GROUP BY st.id
       ORDER BY total_quarters DESC, st.full_name
       LIMIT ?
    `).all(topN);
    const { formatQuarters } = require('./services/marks');
    res.json({
      topN,
      entries: rows.map((r, i) => ({
        rank: i + 1,
        fullName: r.full_name,
        grade: r.grade,
        totalMark: formatQuarters(r.total_quarters),
      })),
    });
  });

  // ---- admin -----------------------------------------------------------
  const adminOnly = requireRole('admin');

  // ---- برنامه راهبردی (ادمین) CRUD -----------------------------------
  app.get('/api/admin/strategic-phases', adminOnly, (req, res) => {
    const gradeId = req.query.gradeId ? Number(req.query.gradeId) : null;
    res.json({ phases: strategic.listPhases(db, { gradeId: gradeId || undefined }) });
  });
  app.get('/api/admin/strategic-phases/:id', adminOnly, (req, res) => {
    res.json({ phase: strategic.getPhase(db, Number(req.params.id)) });
  });
  app.post('/api/admin/strategic-phases', adminOnly, (req, res, next) => {
    try {
      const phase = strategic.createPhase(db, req.body || {}, { actor: 'admin' });
      res.status(201).json({ phase });
    } catch (e) { next(e); }
  });
  app.patch('/api/admin/strategic-phases/:id', adminOnly, (req, res, next) => {
    try {
      const phase = strategic.updatePhase(db, Number(req.params.id), req.body || {}, { actor: 'admin' });
      res.json({ phase });
    } catch (e) { next(e); }
  });
  app.delete('/api/admin/strategic-phases/:id', adminOnly, (req, res, next) => {
    try {
      res.json(strategic.deletePhase(db, Number(req.params.id), { actor: 'admin' }));
    } catch (e) { next(e); }
  });

  // ---- تنظیمات سامانه (متن‌های صفحه، پرچم‌ها، رتبه‌بندی) ---------------
  // کلیدها، نوع‌ها، برچسب‌ها و مقدارِ مؤثرِ هر تنظیم برگردانده می‌شود تا پنل
  // ادمین بتواند فرم را به‌صورت خودکار بسازد.
  app.get('/api/admin/settings', adminOnly, (_req, res, next) => {
    try {
      res.json({ settings: settings.getAll(db), schema: settings.describe(db) });
    } catch (e) { next(e); }
  });
  app.patch('/api/admin/settings', adminOnly, (req, res, next) => {
    try {
      const body = req.body || {};
      const patch = body.settings && typeof body.settings === 'object' ? body.settings : body;
      res.json({ settings: settings.setMany(db, patch, { actor: req.auth && req.auth.username }) });
    } catch (e) { next(e); }
  });

  // ---- آزمون‌های منقضی‌شده → مجموعه تمرین ----------------------------
  app.get('/api/admin/exams/expired', adminOnly, (_req, res, next) => {
    try {
      res.json({ exams: practice.listExpiredExams(db) });
    } catch (e) { next(e); }
  });
  app.post('/api/admin/exams/:id/to-practice', adminOnly, (req, res, next) => {
    try {
      const examId = Number(req.params.id);
      if (!Number.isInteger(examId)) throw badRequest('bad_id', 'شناسه نامعتبر است');
      if (!settings.get(db, 'allow_practice_after_expiry')) {
        throw badRequest('practice_disabled', 'حل تمرینی آزمون‌های منقضی‌شده غیرفعال است');
      }
      res.json(practice.convertExamToPractice(db, examId, { actor: req.auth && req.auth.username }));
    } catch (e) { next(e); }
  });

  // ---- فهرست شرکت‌کنندگان یک آزمون (برای چاپ) -------------------------
  app.get('/api/admin/exams/:id/participants', adminOnly, (req, res, next) => {
    try {
      const examId = Number(req.params.id);
      const exam = db.prepare('SELECT id, title FROM exams WHERE id = ?').get(examId);
      if (!exam) throw notFound('آزمون یافت نشد');
      const rows = db.prepare(`
        SELECT st.id AS student_id, st.full_name, g.label AS grade, f.label AS field,
               s.status,
               (SELECT COALESCE(SUM(qs.quarters), 0) FROM question_scores qs
                  JOIN grading_assignments ga ON ga.id = qs.assignment_id
                 WHERE ga.submission_id = s.id) AS total_quarters
          FROM submissions s
          JOIN students st ON st.id = s.student_id
          JOIN grades g ON g.id = st.grade_id
          JOIN academic_fields f ON f.id = st.field_id
         WHERE s.exam_id = ?
         ORDER BY total_quarters DESC, st.full_name
      `).all(examId);
      const { formatQuarters } = require('./services/marks');
      res.json({
        exam: { id: exam.id, title: exam.title },
        participants: rows.map((r, i) => ({
          rank: r.status === 'submitted' ? i + 1 : null,
          studentId: r.student_id,
          fullName: r.full_name,
          grade: r.grade,
          field: r.field,
          status: r.status,
          totalMark: r.status === 'submitted' ? formatQuarters(r.total_quarters) : null,
        })),
      });
    } catch (e) { next(e); }
  });


  app.get('/api/admin/registrations', adminOnly, (req, res) => {
    const status = ['pending', 'accepted', 'rejected'].includes(req.query.status) ? req.query.status : null;
    res.json({ registrations: listRegistrations(db, { status }) });
  });

  app.post('/api/admin/registrations/:id/decision', adminOnly, (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw badRequest('invalid_id', 'شناسه نامعتبر است');
      const action = req.body && req.body.action;
      if (!['accept', 'reject'].includes(action)) throw badRequest('invalid_action', 'عملیات نامعتبر است');
      const r = decideRegistration(db, { requestId: id, action, actor: 'admin', source: 'web' });
      res.json({ result: r });
    } catch (e) { next(e); }
  });

  app.get('/api/admin/students', adminOnly, (_req, res) => {
    res.json({
      students: db.prepare(
        `SELECT s.id, s.username, s.full_name, g.label AS grade, f.label AS field, s.status, s.created_at, s.disabled_at
           FROM students s JOIN grades g ON g.id = s.grade_id JOIN academic_fields f ON f.id = s.field_id
          ORDER BY s.created_at DESC LIMIT 500`
      ).all(),
    });
  });

  app.post('/api/admin/students/:id/status', adminOnly, (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const status = req.body && req.body.status;
      if (!Number.isInteger(id) || !['active', 'disabled'].includes(status)) throw badRequest('invalid_input', 'ورودی نامعتبر است');
      const now = new Date().toISOString();
      db.transaction(() => {
        const s = db.prepare('SELECT id, status FROM students WHERE id = ?').get(id);
        if (!s) throw notFound('دانش‌آموز یافت نشد');
        if (s.status === status) return;
        db.prepare('UPDATE students SET status = ?, updated_at = ?, disabled_at = ? WHERE id = ?')
          .run(status, now, status === 'disabled' ? now : null, id);
        if (status === 'disabled') revokeStudentSessions(db, id);
        recordAudit(db, { actor: 'admin', action: status === 'disabled' ? 'student.disabled' : 'student.restored', entityType: 'student', entityId: id }, new Date(now));
      })();
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post('/api/admin/outbox/retry', adminOnly, (_req, res) => {
    res.json({ requeued: retryFailed(db) });
    triggerOutbox();
  });

  app.get('/api/admin/outbox', adminOnly, (req, res) => {
    const status = ['pending', 'sending', 'sent', 'failed'].includes(req.query.status) ? req.query.status : 'failed';
    res.json({
      items: db.prepare(
        `SELECT id, dedupe_key, channel, status, attempts, last_error, created_at, sent_at
           FROM notification_outbox WHERE status = ? ORDER BY id DESC LIMIT 200`
      ).all(status),
    });
  });

  app.get('/api/admin/audit', adminOnly, (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({
      entries: db.prepare(
        'SELECT id, created_at, actor, action, entity_type, entity_id, details FROM audit_log ORDER BY id DESC LIMIT ?'
      ).all(limit).map((e) => ({ ...e, details: e.details ? JSON.parse(e.details) : null })),
    });
  });

  // ---- exams, grading, files --------------------------------------------
  mountExamRoutes(app, { db, config, log, triggerOutbox: () => triggerOutbox() });
  mountResultRoutes(app, { db, config });

  // ---- Telegram webhook --------------------------------------------------
  app.post('/api/telegram/webhook', express.json({ limit: '64kb' }), async (req, res) => {
    if (!config.telegram.botToken || !config.telegram.webhookSecret) return res.status(404).end();
    const header = String(req.get('x-telegram-bot-api-secret-token') || '');
    const a = Buffer.from(header), b = Buffer.from(config.telegram.webhookSecret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).end();

    res.status(200).end(); // acknowledge fast; processing is idempotent
    const update = req.body || {};
    try {
      if (update.callback_query) {
        await handleRegistrationCallback(db, update.callback_query, {
          allowedIds: config.telegram.adminIds,
          signingKey: config.telegram.callbackSigningKey,
          client: telegram,
          log,
        });
      } else if (update.message && typeof update.message.text === 'string') {
        const fromId = String(update.message.from && update.message.from.id);
        const chatId = update.message.chat && update.message.chat.id;
        if (!isAuthorizedTelegramUser(config.telegram.adminIds, fromId)) return;
        if (/^\/(pending|start)(@\w+)?$/.test(update.message.text.trim())) {
          const pending = listRegistrations(db, { status: 'pending', limit: 10 });
          if (!pending.length) {
            await telegram.sendMessage(chatId, 'درخواست در انتظار تأیید وجود ندارد.');
          }
          for (const p of pending) {
            await telegram.sendMessage(chatId, formatRegistrationMessage({
              requestId: p.id, fullName: p.full_name, username: p.username,
              grade: p.grade, field: p.field, submittedAt: p.created_at,
            }), {
              inline_keyboard: [[
                { text: '✅ تأیید', callback_data: buildCallbackData(config.telegram.callbackSigningKey, p.id, 'accept') },
                { text: '❌ رد', callback_data: buildCallbackData(config.telegram.callbackSigningKey, p.id, 'reject') },
              ]],
            });
          }
        }
      }
    } catch (err) {
      log.error && log.error('[telegram] webhook processing failed', err && err.message);
    }
  });

  // ---- background outbox -------------------------------------------------
  let outboxRunning = false;
  async function runOutbox() {
    if (outboxRunning || !telegram || !telegram.enabled) return;
    outboxRunning = true;
    try {
      await processDue(db, (row) => {
        if (row.channel === 'telegram_admin') return buildAdminDelivery(row, { client: telegram, signingKey: config.telegram.callbackSigningKey });
        throw new Error(`unsupported channel ${row.channel}`);
      }, { maxAttempts: config.outbox.maxAttempts, log });
    } catch (e) {
      log.error && log.error('[outbox] run failed', e.message);
    } finally {
      outboxRunning = false;
    }
  }
  function triggerOutbox() { setImmediate(runOutbox); }

  // ---- errors --------------------------------------------------------------
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next(notFound('مسیر یافت نشد'));
    next();
  });
  app.use(errorHandler(log));

  app.locals.runOutbox = runOutbox;
  return app;
}

module.exports = { createApp, AppError };
