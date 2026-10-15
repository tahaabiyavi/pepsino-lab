'use strict';
// Input validation for registration. Server-side only; the browser is
// never trusted. Usernames are case-insensitive and stored lowercase.
const { badRequest } = require('./errors');

const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const RESERVED = new Set(['admin', 'root', 'support', 'telegram', 'pepsino']);

function normalizeUsername(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function validateRegistrationInput(input) {
  const errors = {};
  const fullName = typeof input.fullName === 'string' ? input.fullName.trim().replace(/\s+/g, ' ') : '';
  const username = normalizeUsername(input.username);
  const password = typeof input.password === 'string' ? input.password : '';
  const gradeCode = typeof input.gradeCode === 'string' ? input.gradeCode.trim() : '';
  const fieldCode = typeof input.fieldCode === 'string' ? input.fieldCode.trim() : '';

  if (fullName.length < 3 || fullName.length > 100) errors.fullName = 'نام و نام خانوادگی باید بین ۳ تا ۱۰۰ کاراکتر باشد';
  else if (/[<>{}\[\]\\]/.test(fullName)) errors.fullName = 'نام شامل کاراکترهای غیرمجاز است';

  if (!USERNAME_RE.test(username)) errors.username = 'نام کاربری فقط شامل حروف انگلیسی کوچک، عدد و _ (۳ تا ۳۲ کاراکتر) باشد';
  else if (RESERVED.has(username)) errors.username = 'این نام کاربری رزرو شده است';

  const { checkPasswordPolicy } = require('../auth/passwords');
  const pwError = checkPasswordPolicy(password);
  if (pwError) errors.password = pwError;

  if (!gradeCode || gradeCode.length > 32) errors.gradeCode = 'پایه تحصیلی نامعتبر است';
  if (!fieldCode || fieldCode.length > 32) errors.fieldCode = 'رشته تحصیلی نامعتبر است';

  if (Object.keys(errors).length) {
    throw badRequest('validation_failed', 'اطلاعات ارسال‌شده معتبر نیست', errors);
  }
  return { fullName, username, password, gradeCode, fieldCode };
}

module.exports = { validateRegistrationInput, normalizeUsername, USERNAME_RE };
