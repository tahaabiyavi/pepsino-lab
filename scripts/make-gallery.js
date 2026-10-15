'use strict';
/**
 * یک صفحه‌ی HTML مستقل می‌سازد که همه‌ی اسکرین‌شات‌ها را (به‌صورت data URI
 * جاسازی‌شده) در کنار هم نشان می‌دهد — برای اینکه در پیش‌نمایشِ ایمنِ
 * workspace هم بدون دسترسی به شبکه درست نمایش داده شود.
 *
 *   node scripts/make-gallery.js
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'screens');
const OUT = path.join(__dirname, '..', 'screens-gallery.html');

const CAPTIONS = {
  '01-login': ['صفحه‌ی ورود', 'تب «ورود» — فرم نام کاربری / رمز عبور برای همهٔ نقش‌ها'],
  '02-register': ['ثبت‌نام دانش‌آموز', 'تب دومِ منوی ورود — نام، نام کاربری، پایه و رشته'],
  '03-student-home': ['پنل دانش‌آموز · خانه (بالا)', 'هیرو، کارتِ «امشب» با شمارش‌معکوس زنده، آمار و کارت‌های مراحل'],
  '04-student-calendar-exams': ['پنل دانش‌آموز · خانه (پایین)', 'تقویم شمسی ماهانه، آزمون‌های پیش‌رو، تمرینِ آزمون‌های منقضی و لیدربورد'],
  '05-admin-registrations': ['پنل ادمین · درخواست‌های ثبت‌نام', 'نمای پیش‌فرضِ ادمین'],
  '06-admin-settings': ['پنل ادمین · تنظیمات', 'فرم ساخته‌شده از روی schema + جدول آزمون‌های منقضی‌شده برای تبدیل به تمرین'],
  '07-grader': ['پنل مصحح', 'برگه‌های ارجاع‌شده برای نمره‌دهی'],
};

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.png')).sort();
if (!files.length) { console.error('هیچ اسکرین‌شاتی در ' + DIR + ' نیست'); process.exit(1); }

const cards = files.map((f) => {
  const key = f.replace(/\.png$/, '');
  const [title, desc] = CAPTIONS[key] || [key, ''];
  const b64 = fs.readFileSync(path.join(DIR, f)).toString('base64');
  return `    <figure class="card">
      <div class="bar"><span></span><span></span><span></span></div>
      <img src="data:image/png;base64,${b64}" alt="${title}">
      <figcaption><b>${title}</b><span>${desc}</span></figcaption>
    </figure>`;
}).join('\n');

const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>پنل‌های سامانه pepsino LAB</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 60px;
    background: #F6F1E4;
    font-family: 'Vazirmatn', 'Noto Sans Arabic', Tahoma, sans-serif;
    color: #4A2E1E;
  }
  header { max-width: 1180px; margin: 0 auto 30px; text-align: center; }
  header h1 { margin: 0 0 8px; font-size: 26px; letter-spacing: -.2px; }
  header p { margin: 0; color: #7B5A44; font-size: 14px; }
  .wrap { max-width: 1180px; margin: 0 auto; display: grid; gap: 28px; }
  .card {
    margin: 0; background: #FFFDF6; border: 1.5px solid #EBD9BC;
    border-radius: 16px; overflow: hidden; box-shadow: 0 6px 20px rgba(74,46,30,.08);
  }
  .bar {
    display: flex; gap: 6px; padding: 10px 14px; background: #FFF8EA;
    border-bottom: 1.5px solid #EBD9BC;
  }
  .bar span { width: 10px; height: 10px; border-radius: 50%; background: #E4D2B4; }
  .bar span:first-child { background: #E0512F; }
  .card img { display: block; width: 100%; height: auto; }
  figcaption { padding: 14px 18px 18px; border-top: 1.5px solid #F3E7CE; }
  figcaption b { display: block; font-size: 16px; margin-bottom: 4px; }
  figcaption span { font-size: 13px; color: #7B5A44; line-height: 1.7; }
  footer {
    max-width: 1180px; margin: 34px auto 0; text-align: center;
    font-size: 12.5px; color: #9A8266;
  }
</style>
</head>
<body>
  <header>
    <h1>منوی لاگین و پنل هر نقش</h1>
    <p>خروجی واقعیِ مرورگر (۱۴۴۰×۹۰۰) از سرورِ در حال اجرا — فونتِ Vazirmatn</p>
  </header>
  <div class="wrap">
${cards}
  </div>
  <footer>برای دیدنِ هر تصویر با اندازه‌ی کامل، فایل‌های داخل پوشه‌ی <code>screens/</code> را باز کنید.</footer>
</body>
</html>`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('نوشته شد: ' + OUT);
console.log(`  ${files.length} تصویر، ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} مگابایت`);
