'use strict';
/* pepsino LAB — تقویم شمسی و شمارش معکوس در سمتِ کلاینت.
   سرور تاریخ‌ها را میلادی نگه می‌دارد و خودش هم تبدیل را انجام می‌دهد
   (services/jalali.js)؛ این نسخه برای تعاملِ زنده‌ی تقویم و شمارش معکوس
   استفاده می‌شود تا هر حرکتِ کاربر نیاز به رفت‌وبرگشت نداشته باشد.
   منطقِ تبدیل دقیقاً همان نسخه‌ی سرور است. */

const Jalali = (() => {
  const MONTHS_FA = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
    'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
  const WEEKDAYS_FA = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];

  function isLeap(jy) {
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

  function j2g(jy, jm, jd) {
    jy = +jy; jm = +jm; jd = +jd;
    const jy1 = jy + 1595;
    let days = -355668 + (365 * jy1) + (((jy1 / 33) | 0) * 8) + (((((jy1 % 33) + 3) / 4) | 0)) + jd
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

  function g2j(gy, gm, gd) {
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

  function monthLength(jy, jm) {
    if (jm <= 6) return 31;
    if (jm <= 11) return 30;
    return isLeap(jy) ? 30 : 29;
  }

  function toJalali(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return null;
    const { jy, jm, jd } = g2j(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return { jy, jm, jd, monthName: MONTHS_FA[jm - 1], weekday: WEEKDAYS_FA[(d.getDay() + 1) % 7] };
  }

  /** نمایشِ کوتاه: «۱۵ مهر» */
  function short(date) {
    const j = toJalali(date);
    return j ? `${faNum(j.jd)} ${j.monthName}` : '—';
  }

  /** نمایشِ کامل: «چهارشنبه ۱۵ مهر ۱۴۰۵» */
  function long(date) {
    const j = toJalali(date);
    return j ? `${j.weekday} ${faNum(j.jd)} ${j.monthName} ${faNum(j.jy)}` : '—';
  }

  return { j2g, g2j, toJalali, monthLength, isLeap, short, long, MONTHS_FA, WEEKDAYS_FA };
})();

/**
 * شمارش معکوسِ زنده. یک المان را هر ثانیه به‌روز می‌کند.
 * target: Date | ISO string | null
 * خروجیِ هر بار صدا زدن: { d, h, m, s, ms, done }
 */
const Countdown = (() => {
  function diff(target) {
    if (!target) return { d: 0, h: 0, m: 0, s: 0, ms: 0, done: true };
    const ms = new Date(target).getTime() - Date.now();
    if (!isFinite(ms) || ms <= 0) return { d: 0, h: 0, m: 0, s: 0, ms: 0, done: true };
    const total = Math.floor(ms / 1000);
    return {
      d: Math.floor(total / 86400),
      h: Math.floor((total % 86400) / 3600),
      m: Math.floor((total % 3600) / 60),
      s: total % 60,
      ms,
      done: false,
    };
  }

  const pad = (n) => String(n).padStart(2, '0');

  /** رشته‌ی «۰۲ روز ۰۵:۱۳:۴۲» (یا فقط ساعت وقتی کمتر از یک روز مانده) */
  function format(target, { withDays = true } = {}) {
    const t = diff(target);
    if (t.done) return '۰۰:۰۰:۰۰';
    const clock = `${faNum(pad(t.h))}:${faNum(pad(t.m))}:${faNum(pad(t.s))}`;
    if (withDays && t.d > 0) return `${faNum(t.d)} روز ${clock}`;
    return clock;
  }

  const timers = new Map();

  /**
   * یک المان را به‌صورت زنده به‌روز می‌کند.
   * mount(el, target, { onDone, withDays })
   * با mountِ دوباره روی همان کلید، تایمر قبلی پاک می‌شود.
   */
  function mount(el, target, { onDone, withDays = true, key } = {}) {
    const id = key || el;
    if (timers.has(id)) clearInterval(timers.get(id));
    const render = () => {
      if (!el) return;
      const t = diff(target);
      el.textContent = format(target, { withDays });
      el.dataset.done = t.done ? '1' : '0';
      if (t.done) {
        clearInterval(timers.get(id));
        timers.delete(id);
        if (onDone) onDone();
      }
    };
    render();
    if (!diff(target).done) timers.set(id, setInterval(render, 1000));
    return () => { clearInterval(timers.get(id)); timers.delete(id); };
  }

  function stopAll() {
    for (const t of timers.values()) clearInterval(t);
    timers.clear();
  }

  return { diff, format, mount, stopAll };
})();

if (typeof window !== 'undefined') {
  window.Jalali = Jalali;
  window.Countdown = Countdown;
}
