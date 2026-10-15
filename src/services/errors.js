'use strict';
// Typed application error. Routes map `status` to HTTP codes and return
// only `code` and `message` to clients. Internal details stay in logs.
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, msg, details) => new AppError(400, code, msg, details);
const unauthorized = (msg = 'ورود لازم است') => new AppError(401, 'unauthorized', msg);
const forbidden = (msg = 'دسترسی ندارید') => new AppError(403, 'forbidden', msg);
const notFound = (msg = 'یافت نشد') => new AppError(404, 'not_found', msg);
const conflict = (code, msg, details) => new AppError(409, code, msg, details);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
