'use strict';
/**
 * نمونه‌ی خروجیِ چاپ (PDF) را با داده‌ی واقعیِ سرور می‌سازد و در یک فایل
 * HTML مستقل ذخیره می‌کند تا بشود آن را در مرورگر باز کرد و «ذخیره به‌عنوان PDF» زد.
 *
 *   node scripts/make-print-sample.js           →  print-sample.html
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const PUBLIC = path.join(__dirname, '..', 'public');
const OUT = path.join(__dirname, '..', 'print-sample.html');

async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return 'pl_sid=' + /pl_sid=([^;]+)/.exec(r.headers.get('set-cookie') || '')[1];
}

(async () => {
  const admin = await login('admin', 'AdminPass123');
  const student = await login('stu1', 'StudentPass1');

  const get = (p, cookie) => fetch(BASE + p, { headers: { origin: BASE, cookie } }).then((r) => r.json());

  const settings = await get('/api/admin/settings', admin);
  const headerLine = settings.settings.print_header_line;

  // داده‌ی برنامه راهبردی از نگاهِ یک دانش‌آموز
  const home = await get('/api/student/home', student);

  // آزمونی که نتایجش منتشر شده باشد (برای کارنامه و فهرست شرکت‌کنندگان)
  const exams = await get('/api/admin/exams', admin);
  let examId = null, participants = null, reportCard = null;
  for (const e of exams.exams) {
    const p = await get(`/api/admin/exams/${e.id}/participants`, admin);
    if ((p.participants || []).length) {
      examId = e.id; participants = p;
      try {
        const rc = await get(`/api/admin/report-cards/${e.id}/${p.participants[0].studentId}`, admin);
        reportCard = rc.reportCard;
      } catch (err) {}
      break;
    }
  }

  // DOMِ میزبان برای اجرای ماژول‌های فرانت‌اند
  const dom = new JSDOM('<!doctype html><html dir="rtl"><head><meta charset="utf-8"></head><body></body></html>',
    { url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  w.alert = () => {}; w.confirm = () => true; w.print = () => {}; w.scrollTo = () => {};

  for (const src of ['assets/js/api.js', 'assets/js/icons.js', 'assets/js/jalali.js', 'assets/js/print.js']) {
    const el = w.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(PUBLIC, src), 'utf8');
    w.document.body.appendChild(el);
  }

  const Print = w.Print;
  const printCss = fs.readFileSync(path.join(PUBLIC, 'assets/print.css'), 'utf8');

  const pages = [];

  // ۱) برنامهٔ راهبردی
  const rows = (home.planTable || home.phases || []).map((p) => ({
    title: p.title,
    startsAt: p.startsAt || p.starts_at,
    endsAt: p.endsAt || p.ends_at,
    status: p.status,
    topicsText: p.topicsText,
  }));
  Print.planTable(rows, { headerLine, title: home.texts.plan_title });
  pages.push(w.document.getElementById('printArea').innerHTML);
  Print.close();

  // ۲) فهرست شرکت‌کنندگان
  if (participants && participants.participants.length) {
    Print.participants(participants.exam, participants.participants, { headerLine });
    pages.push(w.document.getElementById('printArea').innerHTML);
    Print.close();
  }

  // ۳) کارنامه
  if (reportCard) {
    Print.reportCard(reportCard, { headerLine });
    pages.push(w.document.getElementById('printArea').innerHTML);
    Print.close();
  }

  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<title>نمونهٔ خروجی چاپ — pepsino LAB</title>
<style>
${printCss}
/* این فایل فقط برای نمایش است: نوارِ ابزار را هم نشان می‌دهیم */
.p-toolbar { display: none; }
body { background:#F6F1E4; margin:0; padding:24px 0; font-family:'Vazirmatn',sans-serif; }
.p-page { box-shadow:0 6px 24px rgba(74,46,30,.14); margin-bottom:26px; padding:12mm 12mm; max-width:820px; }
@media print { body { background:#fff; padding:0 } .p-page { box-shadow:none; margin:0; padding:0 } }
</style>
</head>
<body>
${pages.join('\n<div class="p-break"></div>\n')}
</body>
</html>`;

  fs.writeFileSync(OUT, html, 'utf8');
  console.log(`نوشته شد: ${OUT}`);
  const names = ['برنامه راهبردی'];
  if (participants && participants.participants.length) names.push('فهرست شرکت‌کنندگان');
  if (reportCard) names.push('کارنامه');
  console.log(`  ${pages.length} برگه: ${names.join('، ')}`);
  process.exit(0);
})().catch((e) => { console.error('خطا:', e.message); process.exit(1); });
