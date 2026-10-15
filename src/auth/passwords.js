'use strict';
// Password hashing with bcrypt (cost configurable via BCRYPT_ROUNDS).
// Plaintext passwords are never logged, stored, or returned by the API.
const bcrypt = require('bcryptjs');

const MIN_LEN = 8;
const MAX_LEN = 128;   // bcrypt only uses the first 72 bytes; cap input size anyway

function hashPassword(plain, rounds = 12) {
  return bcrypt.hashSync(plain, rounds);
}

function verifyPassword(plain, hash) {
  if (typeof plain !== 'string' || typeof hash !== 'string') return false;
  return bcrypt.compareSync(plain, hash);
}

// Used to equalise timing when a username does not exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 12);

function checkPasswordPolicy(plain) {
  if (typeof plain !== 'string') return 'رمز عبور نامعتبر است';
  if (plain.length < MIN_LEN) return `رمز عبور باید حداقل ${MIN_LEN} کاراکتر باشد`;
  if (plain.length > MAX_LEN) return `رمز عبور حداکثر ${MAX_LEN} کاراکتر است`;
  if (!/[A-Za-z]/.test(plain) || !/[0-9]/.test(plain)) {
    return 'رمز عبور باید شامل حروف لاتین و عدد باشد';
  }
  return null;
}

module.exports = { hashPassword, verifyPassword, checkPasswordPolicy, DUMMY_HASH, MIN_LEN, MAX_LEN };
