'use strict';
/**
 * تبدیل تقویم شمسی (جلالی) ↔ میلادی
 * ------------------------------------------------
 * سرور تاریخ‌ها را به میلادیِ UTC در دیتابیس نگه می‌دارد. تقویمِ نمایش‌داده‌شده
 * به دانش‌آموز باید شمسی باشد، پس تبدیل اینجا انجام می‌شود و نتیجه همراهِ
 * داده به کلاینت فرستاده می‌شود (کلاینت فقط نمایش می‌دهد).
 *
 * الگوریتمِ تبدیل همان الگوریتمِ شناخته‌شده‌ی برگرفته از رویه‌ی
 * Borkowski است که در پروژه‌ی قدیمی هم استفاده می‌شد؛ اینجا در
 * یک ماژولِ قابل‌تست و مستقل از رابط کاربری پیاده شده است.
 */

const MONTHS_FA = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

// نام روزهای هفته به ترتیبِ روزِ شنبه (ابتدای هفته‌ی شمسی)
const WEEKDAYS_FA = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];

function isLeapJalali(jy) {
  // دقتِ بالا بر اساس دوره‌ی ۲۸۲۰ ساله
  const breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210,
    1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  let jp = breaks[0];
  let jump = 0;
  for (let i = 0; i < 19; i++) {
    const jm = breaks[i];
    jump = breaks[i + 1] - jm;
    if (jy < jm) break;
    jp = jm;
  }
  let n = jy - jp;
  if (jump - n < 6) n = n - jump + ((jump + 4) / 33 | 0) * 33;
  let leap = ((((n + 1) % 33) - 1) % 4);
  if (leap === -1) leap = 4;
  return leap === 0;
}

/** شمسی → میلادی. ورودی‌ها اعداد صحیح. خروجی { gy, gm, gd } */
function j2g(jy, jm, jd) {
  jy = +jy; jm = +jm; jd = +jd;
  if (!Number.isFinite(jy) || !Number.isFinite(jm) || !Number.isFinite(jd)) {
    throw new Error('jalali: invalid input');
  }
  if (jm < 1 || jm > 12) throw new Error('jalali: month out of range');
  const jy1 = jy + 1595;
  let days = -355668 + (365 * jy1) + (((jy1 / 33) | 0) * 8)
    + (((((jy1 % 33) + 3) / 4) | 0)) + jd
    + (jm < 7 ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);

  let gy = 400 * ((days / 146097) | 0);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * ((--days / 36524) | 0);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * ((days / 1461) | 0);
  days %= 1461;
  if (days > 365) {
    gy += ((days - 1) / 365) | 0;
    days = (days - 1) % 365;
  }
  const gd0 = days + 1;
  const leapG = ((gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0);
  const mLen = [31, leapG ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  let gd = gd0;
  for (let i = 0; i < 12; i++) {
    if (gd <= mLen[i]) break;
    gd -= mLen[i];
    gm++;
  }
  return { gy, gm, gd };
}

/** میلادی → شمسی. خروجی { jy, jm, jd } */
function g2j(gy, gm, gd) {
  gy = +gy; gm = +gm; gd = +gd;
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = (365 * gy) + (((gy2 + 3) / 4) | 0) - (((gy2 + 99) / 100) | 0)
    + (((gy2 + 399) / 400) | 0) - 80 + gd + g_d_m[gm - 1];
  jy += 33 * ((days / 12053) | 0);
  days %= 12053;
  jy += 4 * ((days / 1461) | 0);
  days %= 1461;
  if (days > 365) {
    jy += ((days - 1) / 365) | 0;
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + ((days / 31) | 0) : 7 + (((days - 186) / 30) | 0);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return { jy, jm, jd };
}

/** تاریخِ میلادی (Date یا ISO) → شمسی با نام ماه و روز هفته. */
function toJalali(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const { jy, jm, jd } = g2j(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return {
    jy, jm, jd,
    monthName: MONTHS_FA[jm - 1],
    weekday: WEEKDAYS_FA[(d.getDay() + 1) % 7],
    // فاصله‌ی این روز از ابتدای هفته‌ی شمسی (شنبه = ۰) برای چیدمان شبکه‌ی ماه
    weekdayIndex: (d.getDay() + 1) % 7,
  };
}

/** تعداد روزهای یک ماه شمسی. */
function monthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isLeapJalali(jy) ? 30 : 29;
}

/** روزِ هفته‌ی روزِ اولِ ماه شمسی را برمی‌گرداند (شنبه = ۰). */
function firstWeekdayIndex(jy, jm) {
  const g = j2g(jy, jm, 1);
  const d = new Date(Date.UTC(g.gy, g.gm - 1, g.gd, 12, 0, 0));
  return (d.getUTCDay() + 1) % 7;
}

/** امروزِ شمسی را برمی‌گرداند (بر اساس تاریخِ سرور). */
function today(now = new Date()) { return toJalali(now); }

/**
 * شبکه‌ی یک ماه شمسی برای نمایش تقویم.
 * خروجی شامل خانه‌های خالیِ ابتدای ماه، شماره روز، معادل میلادی و نام ماه است.
 */
function monthGrid(jy, jm) {
  const len = monthLength(jy, jm);
  const start = firstWeekdayIndex(jy, jm);
  const days = [];
  for (let i = 0; i < start; i++) days.push(null);
  for (let d = 1; d <= len; d++) {
    const g = j2g(jy, jm, d);
    days.push({
      day: d,
      gregorian: `${g.gy}-${String(g.gm).padStart(2, '0')}-${String(g.gd).padStart(2, '0')}`,
    });
  }
  // پر کردن خانه‌های انتهایی تا کامل شدن سطر آخر
  while (days.length % 7 !== 0) days.push(null);
  return { jy, jm, monthName: MONTHS_FA[jm - 1], days };
}

/** ماه شمسی را یک ماه جابه‌جا می‌کند (برای دکمه‌های قبل/بعد تقویم). */
function shiftMonth(jy, jm, delta) {
  let y = jy;
  let m = jm + delta;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return { jy: y, jm: m };
}

module.exports = {
  j2g, g2j, toJalali, monthLength, firstWeekdayIndex, monthGrid, shiftMonth, today,
  isLeapJalali, MONTHS_FA, WEEKDAYS_FA,
};
