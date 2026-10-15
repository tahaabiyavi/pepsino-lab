'use strict';
// Authentication, authorization and request-safety middleware.
// Every protected route passes through requireRole(...). Front-end hiding is
// never treated as access control.
const { COOKIE_NAME, resolveSession } = require('../auth/sessions');
const { AppError, unauthorized, forbidden } = require('../services/errors');

function attachSession(db, cfg) {
  return (req, _res, next) => {
    req.auth = null;
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (token) {
      req.auth = resolveSession(db, token, {
        idleHours: cfg.sessionTtlHours,
        absoluteHours: cfg.sessionAbsoluteHours,
      });
      req.sessionToken = token;
    }
    next();
  };
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (roles.length && !roles.includes(req.auth.type)) return next(forbidden());
    next();
  };
}

// CSRF defence for cookie-authenticated, state-changing requests.
// The session cookie is SameSite=Strict; additionally a browser-sent Origin
// must match PUBLIC_ORIGIN. Requests without an Origin (non-browser clients)
// are allowed only if they carry no session cookie.
function csrfOriginGuard(publicOrigin) {
  const safe = new Set(['GET', 'HEAD', 'OPTIONS']);
  return (req, _res, next) => {
    if (safe.has(req.method)) return next();
    if (req.path === '/api/telegram/webhook') return next(); // authenticated by secret header
    const origin = req.headers.origin;
    if (origin) {
      if (origin !== publicOrigin) return next(forbidden('درخواست از منبع مجاز نیست'));
      return next();
    }
    if (req.cookies && req.cookies[COOKIE_NAME]) return next(forbidden('درخواست از منبع مجاز نیست'));
    next();
  };
}

function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'JSON نامعتبر است' } });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'payload_too_large', message: 'حجم درخواست بیش از حد مجاز است' } });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
    log.error && log.error('[http] unhandled', { path: req.path, message: err && err.message });
    return res.status(500).json({ error: { code: 'internal_error', message: 'خطای داخلی سرور' } });
  };
}

module.exports = { attachSession, requireRole, csrfOriginGuard, errorHandler };
