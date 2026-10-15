'use strict';
/**
 * تست دود (smoke test) برای صفحه‌ها:
 * هر صفحه را در یک DOM واقعی بار می‌کند، اسکریپت‌ها را اجرا می‌کند و بررسی
 * می‌کند که خطای JS رخ ندهد و بخش‌های اصلی رندر شوند.
 * برای اجرا باید سرور روی PORT روشن باشد:
 *   node scripts/smoke-pages.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const PUBLIC = path.join(__dirname, '..', 'public');

/** ورود با نام کاربری و گرفتن کوکیِ نشست. */
async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login failed for ${username}: ${r.status}`);
  const setCookie = r.headers.get('set-cookie') || '';
  const m = /pl_sid=([^;]+)/.exec(setCookie);
  if (!m) throw new Error(`no session cookie for ${username}`);
  return `pl_sid=${m[1]}`;
}

/** ساخت یک DOM که fetch را به سرور واقعی وصل می‌کند. */
async function makeDom(file, cookie) {
  const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.message || e)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  vc.on('warn', (...a) => { if (process.env.SMOKE_VERBOSE) errors.push('console.warn: ' + a.join(' ')); });

  const dom = new JSDOM(html, {
    url: `${BASE}/${file}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: undefined,      // اسکریپت‌ها را خودمان بعداً اجرا می‌کنیم
  });
  const { window } = dom;

  // fetch : مسیرهای نسبی را به سرور واقعی می‌فرستیم
  window.fetch = (url, init = {}) => {
    const abs = String(url).startsWith('http') ? String(url) : `${BASE}${url}`;
    return fetch(abs, {
      ...init,
      headers: { ...(init.headers || {}), origin: BASE, cookie },
    });
  };
  window.addEventListener('unhandledrejection', (ev) => {
    errors.push('unhandled rejection: ' + (ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason)));
  });
  window.alert = () => {};
  window.confirm = () => true;
  window.print = () => { window.__printed = (window.__printed || 0) + 1; };
  window.scrollTo = () => {};

  // اسکریپت‌ها را به‌صورت المانِ واقعی اجرا می‌کنیم تا const/let در محدوده‌ی
  // سراسریِ مشترک بین فایل‌ها قرار بگیرد (رفتارِ مرورگر)
  const scripts = [...dom.window.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
  for (const src of scripts) {
    const code = fs.readFileSync(path.join(PUBLIC, src), 'utf8');
    const el = dom.window.document.createElement('script');
    el.textContent = code;
    try {
      dom.window.document.body.appendChild(el);
    } catch (e) {
      errors.push(`script ${src}: ${e.message}`);
    }
  }
  return { dom, window, errors };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(file, cookie, assertions, before) {
  const { window, errors } = await makeDom(file, cookie);
  // boot() به‌صورت ناهم‌زمان اجرا می‌شود؛ صبر می‌کنیم تا درخواست‌ها تمام شود
  await wait(2500);
  if (before) {
    before(window.document);
    await wait(2000);      // صبر برای loaderِ تب
  }
  const problems = [...errors];
  for (const [label, fn] of Object.entries(assertions)) {
    try {
      const ok = fn(window.document, window);
      if (!ok) problems.push(`${label}: assertion failed`);
    } catch (e) { problems.push(`${label}: ${e.message}`); }
  }
  window.close();
  return { file, problems };
}

(async () => {
  const results = [];
  try {
    const studentCookie = await login('stu1', 'StudentPass1');
    results.push(await check('student.html', studentCookie, {
      'نوارِ منو آیکون دارد': (d) => d.querySelectorAll('nav.main .ico').length >= 5,
      'بخش خانه نمایش داده شده': (d) => !d.getElementById('view-home').classList.contains('hidden'),
      'عنوانِ برنامه پر شده': (d) => (d.getElementById('homeTitle').textContent || '').length > 0,
      // هر آزمونِ پیش‌رو کارتِ وضعیتِ خودش را با شمارش معکوس می‌گیرد (قبلاً فقط یکی بود)
      'کارت‌های وضعیتِ آزمون ساخته شده': (d) => {
        const cards = d.querySelectorAll('#homeCurrentCards [data-cd-card]');
        return cards.length >= 1
          && Array.from(cards).every((c) => c.querySelector('h3') && c.querySelector('.tag'));
      },
      'هر آزمونِ پیش‌رو شمارش معکوس دارد': (d) => Array.from(
        d.querySelectorAll('#homeCurrentCards [data-cd-card]'),
      ).every((c) => c.querySelectorAll('.count-nums .u-num').length === 4),
      'آزمونِ قفل‌شده دکمه‌ی ورود ندارد': (d) => Array.from(
        d.querySelectorAll('#homeCurrentCards .card'),
      ).every((c) => (!c.querySelector('.tag').textContent.includes('قفل')
        || !c.querySelector('[data-exam-act]'))),
      'آمار رندر شده': (d) => d.querySelectorAll('#homeStatGrid .sbox').length >= 4,
      'برنامه راهبردی رندر شده': (d) => d.querySelectorAll('#homePlanList .night-card').length >= 1,
      'جدول برنامه پر شده': (d) => d.querySelectorAll('#homePlanTableBody tr').length >= 1,
      'تقویم رندر شده': (d) => d.querySelectorAll('#homeCalBody .cal-cell').length >= 28,
      'آزمون‌ها رندر شده': (d) => d.querySelectorAll('#homeExamGrid .night-card').length >= 1,
      // بخش «راهنمای سریع» بنا به درخواست حذف شده است
      'راهنما حذف شده': (d) => !d.getElementById('homeGuideTitle')
        && !d.getElementById('homeGuideStudent')
        && !d.getElementById('homeGuideNotes'),
      'متنِ راهنما در صفحه نیست': (d) => !/راهنمای سریع|نکته‌های مهم/.test(d.body.textContent),
      'عنوانِ برنامه راهبردی': (d) => (d.getElementById('homePlanTitle').textContent || '').includes('برنامه راهبردی'),
      'زیرعنوانِ برنامه خالی است': (d) => (d.getElementById('homePlanSub').textContent || '').trim() === '',
      'متن قدیمیِ برنامه حذف شده': (d) => !/مراحل مربوط به پایه/.test(d.body.textContent),
      'خروجیِ چاپ آماده است': (d) => typeof d.defaultView.Print === 'object',
      'برگهٔ چاپ ساخته شده': (d) => !!d.querySelector('#printArea .p-page'),
      'سربرگِ برند در برگهٔ چاپ': (d) => !!d.querySelector('#printArea .p-head .p-logo'),
      'ردیف‌های جدول برنامه در چاپ': (d) => d.querySelectorAll('#printArea .p-table tbody tr').length >= 1,
      'چاپ فراخوانی شده': (d, w) => (w.__printed || 0) >= 1,
    }, (doc) => {
      const btn = doc.getElementById('homePrintPlanBtn');
      if (btn) btn.click();
    }));
  } catch (e) { results.push({ file: 'student.html', problems: ['setup: ' + e.message] }); }

  try {
    const adminCookie = await login('admin', 'AdminPass123');
    results.push(await check('admin.html', adminCookie, {
      'تب تنظیمات فعال است': (d) => !d.getElementById('panel-settings').classList.contains('hidden'),
      'تنظیمات ساخته شده': (d) => d.querySelectorAll('#settingsAdminBox input,#settingsAdminBox textarea,#settingsAdminBox select').length >= 10,
      'جدول آزمون‌های منقضی': (d) => (d.getElementById('expiredExamsBox').textContent || '').length > 5,
    }, (doc) => {
      const tab = doc.querySelector('.anav[data-panel="settings"]');
      if (tab) tab.click();
    }));
  } catch (e) { results.push({ file: 'admin.html', problems: ['setup: ' + e.message] }); }

  let failed = 0;
  for (const r of results) {
    const ok = r.problems.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${r.file}`);
    r.problems.forEach((p) => console.log('    - ' + p));
  }
  process.exit(failed ? 1 : 0);
})();
