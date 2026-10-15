'use strict';
// Exact mark arithmetic. Marks are stored as INTEGER quarter-points
// (1 mark = 4 quarters), so 0.25 steps never suffer floating-point error.
// 15.75 marks = 63 quarters.
const { badRequest } = require('./errors');

const MARK_RE = /^(\d{1,3})(?:\.(\d{1,2}))?$/;
const FRAC_TO_Q = { '': 0, '0': 0, '00': 0, '25': 1, '5': 2, '50': 2, '75': 3 };

/** Parse a user-entered mark ("0", "0.5", "1.25", 2) into integer quarters. */
function parseMarkToQuarters(input) {
  let s;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw badRequest('invalid_mark', 'نمره نامعتبر است');
    s = String(input);
  } else if (typeof input === 'string') {
    s = input.trim();
  } else {
    throw badRequest('invalid_mark', 'نمره نامعتبر است');
  }
  const m = MARK_RE.exec(s);
  if (!m) throw badRequest('invalid_mark', 'نمره نامعتبر است');
  const frac = m[2] === undefined ? '' : m[2];
  if (!(frac in FRAC_TO_Q)) {
    throw badRequest('invalid_increment', 'نمره باید مضرب ۰.۲۵ باشد');
  }
  return Number(m[1]) * 4 + FRAC_TO_Q[frac];
}

/** Format integer quarters back to a display mark: 63 -> "15.75", 4 -> "1". */
function formatQuarters(q) {
  if (!Number.isInteger(q) || q < 0) throw new Error('quarters must be a non-negative integer');
  const whole = Math.floor(q / 4);
  const r = q % 4;
  return `${whole}${['', '.25', '.5', '.75'][r]}`;
}

/** حداکثر نمره هر سؤال: ۲ (۸ کوارتر). مصحح فقط ۰ تا ۲ با گام ۰.۲۵ می‌دهد. */
const MAX_QUESTION_QUARTERS = 8; // 2 marks
/** حداکثر مجموع نمرات یک دانش‌آموز: ۲۰ */
const MAX_TOTAL_QUARTERS = 80; // 20 marks

/** Validate a score against a question's maximum (both in quarters).
 *  اگر maxQuarters داده نشود، سقف ثابت ۲ اعمال می‌شود (طبق منطق جدید بارم).
 */
function validateScoreQuarters(quarters, maxQuarters = MAX_QUESTION_QUARTERS) {
  if (!Number.isInteger(quarters)) throw badRequest('invalid_mark', 'نمره نامعتبر است');
  if (quarters < 0) throw badRequest('invalid_mark', 'نمره نمی‌تواند منفی باشد');
  const cap = Math.min(maxQuarters, MAX_QUESTION_QUARTERS);
  if (quarters > cap) {
    throw badRequest('mark_exceeds_max', `نمره از حداکثر نمره‌ی سؤال (${formatQuarters(cap)}) بیشتر است`);
  }
  return quarters;
}

/** بررسی مجموع نمرات؛ اگر از ۲۰ بیشتر شد خطا بده. */
function validateTotalQuarters(totalQuarters) {
  if (totalQuarters > MAX_TOTAL_QUARTERS) {
    throw badRequest('total_exceeds_20', 'نمره از بیست بیشتر است. لطفاً مجدداً نمره بدهید.');
  }
  return totalQuarters;
}

/** مقادیر مجاز نمره هر سؤال برای UI مصحح */
const ALLOWED_MARKS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

module.exports = {
  parseMarkToQuarters, formatQuarters, validateScoreQuarters, validateTotalQuarters,
  MAX_QUESTION_QUARTERS, MAX_TOTAL_QUARTERS, ALLOWED_MARKS,
};
