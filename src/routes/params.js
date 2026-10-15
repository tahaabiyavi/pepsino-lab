'use strict';
// Shared parsing for numeric route parameters and body fields.
const { badRequest } = require('../services/errors');

function normalizeIdParam(value, label = 'شناسه') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) throw badRequest('invalid_id', `${label} نامعتبر است`);
  return n;
}

module.exports = { normalizeIdParam };
