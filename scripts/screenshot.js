'use strict';
/**
 * اسکرین‌شات از صفحه‌ی ورود و پنل هر نقش (دانش‌آموز / ادمین / مصحح).
 * هر نقش در یک «زمینه‌ی مرورگر» جداگانه باز می‌شود تا کوکی‌ها با هم تداخل نکنند.
 *
 * پیش‌نیاز: سرور روی http://localhost:3000 در حال اجرا باشد.
 *   node scripts/screenshot.js
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = process.env.SHOT_BASE || 'http://localhost:3000';
const OUT = process.env.SHOT_OUT || path.join(__dirname, '..', 'screens');
fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const problems = [];

  /** یک زمینه‌ی تازه (بدون کوکی) با صفحه‌ای در اندازه‌ی دسکتاپ */
  async function freshPage(tag) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => problems.push(`${tag}: pageerror ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`${tag}: console ${m.text()}`); });
    return { ctx, page };
  }

  const shot = async (page, name) => {
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('  ✓ ' + name + '.png');
  };

  /** ورود با نام کاربری/رمز و برگرداندنِ صفحه‌ی پنل */
  async function session(tag, u, p) {
    const { ctx, page } = await freshPage(tag);
    await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
    await wait(700);
    await page.waitForSelector('#loginForm input[name="username"]', { timeout: 10000 });
    await page.type('#loginForm input[name="username"]', u);
    await page.type('#loginForm input[name="password"]', p);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
      page.click('#loginForm button[type="submit"]'),
    ]);
    await wait(2400);
    console.log(`  ${u} → ${page.url().replace(BASE, '') || '/'}`);
    return { ctx, page };
  }

  // ---------- صفحه‌ی ورود ----------
  console.log('صفحه‌ی ورود:');
  {
    const { ctx, page } = await freshPage('login');
    await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
    await wait(1300);
    await shot(page, '01-login');
    await page.click('[data-tab="register"]');
    await wait(900);
    await shot(page, '02-register');
    await ctx.close();
  }

  // ---------- دانش‌آموز ----------
  console.log('پنل دانش‌آموز:');
  {
    const { ctx, page } = await session('student', 'stu1', 'StudentPass1');
    await shot(page, '03-student-home');
    await page.evaluate(() => {
      const el = document.getElementById('homeCalTitle');
      if (el) el.scrollIntoView({ block: 'start' });
    });
    await wait(800);
    await shot(page, '04-student-calendar-exams');
    await ctx.close();
  }

  // ---------- ادمین ----------
  console.log('پنل ادمین:');
  {
    const { ctx, page } = await session('admin', 'admin', 'AdminPass123');
    await shot(page, '05-admin-registrations');
    await page.evaluate(() => {
      const t = document.querySelector('.anav[data-panel="settings"]');
      if (t) t.click();
    });
    await wait(2600);
    await shot(page, '06-admin-settings');
    await ctx.close();
  }

  // ---------- مصحح ----------
  console.log('پنل مصحح:');
  try {
    const { ctx, page } = await session('grader', 'grader_demo', 'GraderPass1');
    await shot(page, '07-grader');
    await ctx.close();
  } catch (e) { problems.push('grader: ' + e.message); }

  await browser.close();
  console.log('\nخروجی: ' + OUT);
  if (problems.length) {
    console.log('هشدارها:');
    problems.slice(0, 12).forEach((p) => console.log('  - ' + p));
  }
})().catch((e) => { console.error('خطا:', e); process.exit(1); });
