# pepsino LAB — exam platform (v0.2 foundation)

Node.js + Express + SQLite (better-sqlite3). Designed for a single VPS and fewer than 100 students.
UI, fonts, palette and logo are taken from the live site (pepsinogen.net).

## این نسخه — خلاصه‌ی تحویل نهایی

آزمون‌های این سامانه **تشریحی** هستند (نه تستی): دانش‌آموز پاسخش را به‌صورت فایل می‌فرستد
و مصححِ انسانی به هر سؤال نمره می‌دهد. سقف نمرهٔ هر سؤال ۲ و سقف مجموع ۲۰ است.

### شروع سریع

```bash
npm install
cp .env.example .env        # سپس مقادیر را پر کن
node src/db/migrate.js      # اعمال migrationها
node scripts/seed-demo.js   # دادهٔ نمونه (اختیاری، اما پیشنهادی)
npm start
```

کاربرانِ دادهٔ نمونه:

| نقش | نام کاربری | رمز |
|---|---|---|
| ادمین | `admin` | `AdminPass123` |
| دانش‌آموز | `stu1` … `stu6` | `StudentPass1` |
| مصحح | `grader_demo` | `GraderPass1` |

### امکاناتِ پیاده‌سازی‌شده

- **پنل دانش‌آموز**: خانه (هیرو + کارتِ آزمونِ جاری با شمارش‌معکوسِ زنده + آمار)،
  برنامهٔ راهبردیِ مراحل (نمایش کارتی و جدولی)، **تقویم شمسیِ ماهانه**، آزمون‌های پیش‌رو،
  **آزمون‌های منقضی‌شده به‌شکل تمرین**، لیدربورد، کارنامه، اعتراض، مجموعه‌های تمرین و آزمون‌ها.
- **قفل و انقضای آزمون**: هر آزمون در یکی از وضعیت‌های `before` / `open` / `after` است؛
  پس از پایان مهلت، آزمون به‌صورت خودکار در بخش تمرین در دسترس قرار می‌گیرد.
- **پنل ادمین**: دانش‌آموزان، آزمون‌ها، مصحح‌ها، اعتراض‌ها، رتبه‌بندی، برنامهٔ راهبردی،
  مجموعه‌های تمرین، صندوق اعلان، گزارش فعالیت، و **تنظیماتِ schema-محور**
  (هر کلیدِ جدید بدون تغییرِ دستی در فرم ظاهر می‌شود) + تبدیل آزمون منقضی به تمرین.
- **چاپ / PDF** از طریق چاپِ مرورگر (`window.print()` + شیوه‌نامهٔ RTL):
  کارنامه، برگهٔ سؤالات، پاسخنامه، جدول برنامه، فهرست شرکت‌کنندگان.
  نمونهٔ آماده: `print-sample.html`.
- **آیکون‌های داخلی** (SVG، بدون CDN) و فونتِ Vazirmatn به‌صورت محلی.

### دیپلوی

پروژه روی هر جایی که Node 20 اجرا کند بالا می‌آید. چون پایگاه داده یک فایل SQLite
است، به یک **فضای ذخیره‌سازی پایا** نیاز دارد. سه مسیر آماده در مخزن هست:

| روش | فایل | مناسب برای |
|---|---|---|
| داکر | `Dockerfile` + `docker-compose.yml` | هر VPS |
| یک‌کلیک | `render.yaml` | Render |
| نصب مستقیم | — | سرور شخصی با systemd |

سریع‌ترین راه:

```bash
cp .env.example .env     # حداقل PUBLIC_ORIGIN را پر کن (حتماً https://)
docker compose up -d
```

راهنمای کامل، متغیرهای محیطی و نکات امنیتی: [`DEPLOY.md`](DEPLOY.md).

> تلگرام اختیاری است: بدون `TELEGRAM_BOT_TOKEN` مسیر وب‌هوک ۴۰۴ می‌دهد و
> `TELEGRAM_WEBHOOK_SECRET` / `TELEGRAM_CALLBACK_KEY` لازم نیستند.

### تست و ابزارها

```bash
npm test                          # ۱۱۲ تست
node scripts/smoke-pages.js       # بارگذاری صفحات در DOM واقعی
node scripts/screenshot.js        # اسکرین‌شات از لاگین و پنل هر نقش
node scripts/make-gallery.js      # تبدیل اسکرین‌شات‌ها به یک صفحه‌ی HTML
node scripts/seed-graded.js 1     # سناریوی کامل تصحیح برای دیدن کارنامه
node scripts/make-print-sample.js # ساخت print-sample.html
```

> اسکریپت‌های `smoke-pages` و `screenshot` به وابستگی‌های توسعه نیاز دارند:
> `npm install --no-save jsdom puppeteer`

گزارشِ کاملِ تغییرات در [`CHANGES.md`](CHANGES.md) است و اسکرین‌شات‌های آماده در پوشهٔ `screens/`
(نسخه‌ی یکجای آن‌ها: `screens-gallery.html`).

---

## Status (older notes, kept for reference)

### Implemented and tested (71 automated tests pass)
- Design system: original `site.css` tokens, buttons, cards, the Vazirmatn / Great Vibes / Baloo Brand fonts and the logo, all served locally (no CDN).
- Schema v1 with versioned, transactional migrations (`src/db/migrations/`).
- Student registration: full name, username (validated, case-insensitive, unique), password (bcrypt, never stored in plaintext), grade, field. Creates a **pending** request only. No account exists until approval.
- Telegram approval workflow: admin notification with signed Accept/Reject buttons, `/pending` recovery command, webhook secret verification, allowlist of Telegram user IDs, replay protection (`callback_query_id` is unique), idempotent decisions.
- Web approval/rejection for the admin (same service, same rules).
- Single administrator account (one row enforced by the database), password set by CLI.
- Unified login with server-side role decision, hashed server-side sessions, idle and absolute expiry, `HttpOnly` / `SameSite=Strict` cookies, generic error messages, rate limiting.
- Student disable/restore: revokes sessions immediately; disabled accounts cannot log in or call protected routes.
- Persistent notification outbox with retry, backoff, lease recovery and dedupe keys. Telegram outages never undo a registration.
- Audit log for registration, login, disable/restore and admin password changes (secrets scrubbed).
- Security headers (helmet, CSP), CSRF origin check, input validation, JSON body size limit.
- Online SQLite backup with integrity check and SHA-256 manifest, plus a verification script.


### Added in v0.3 (examination core, tested)
- Migration `002_exams_grading.sql`: academic years, subjects, topics, exams, exam grades/fields/subjects, individual questions with topic links, answer-key metadata, submissions, grader profiles, grading batches and assignments, question scores, score history, exam change log.
- Exact mark arithmetic in integer quarter-points (`src/services/marks.js`). Values must be multiples of 0.25 and cannot exceed the question maximum.
- Exam lifecycle state machine (`draft → published → in_progress → submission_closed → grading → results_published → archived`). Transitions are enforced by the backend. Publication runs pre-publication validation (title, grades, questions, marks, total, answer key, schedule).
- Schedule validation and audited schedule edits. Edits that would invalidate existing submissions are refused.
- Server-enforced submission rules: start time, deadline, eligibility by grade and field, single submission.
- Grading assignment engine: random distribution to the least-loaded active grader (sizes differ by at most one), idempotent re-runs, reassignment of open work only, manual reassignment, completed grading preserved.
- Grading workflow: per-question scores with backend validation, grader-scoped access, finalization that requires every question, audited score corrections with history and a required reason.
- Absence versus zero: non-submitters become `missing` (score 0); administratively `absent` students are excluded from grading and rankings.
- Scheduler (`tick`): closes submission windows, distributes sheets, publishes answer keys on schedule, and publishes results only when grading is complete. Every step is idempotent and catches up after downtime.

### Not yet built (examination layer)
- HTTP routes for exams, questions, grading, and publication. The service layer is complete and tested, but there are no endpoints or screens for it yet.
- File uploads (answer sheets and answer keys) with the 10 MB limit, type sniffing, and private storage. Only metadata tables exist.
- Floating submission windows and per-student session timing (only fixed deadlines are implemented).
- Report cards, score history charts, rankings, appeals, practice mode, calendar, strategic plans, exports, and importing the legacy data.

### Earlier planned list (kept for reference)
Examinations, questions, answer keys and PDFs, timed sessions and submissions, file uploads (10 MB limit, content validation, private storage), grader profiles and the assignment engine, grading workspace and score audit, publication scheduler, report cards, score history, rankings, appeals, practice mode, calendar, strategic plans, reports and exports, and **migration of the existing live data** (see below). These require the legacy data to be migrated first.

### Important: existing live site
The live site's `/api/state` endpoint is publicly readable and returns the full JSON state, including `settings.password` (a plaintext value), 437 result records and question data. This needs to be fixed on the live server immediately: rotate that password, disable or protect the endpoint, and treat the exposed records as potentially compromised. I did not modify the live site. A verified backup of its state was saved to `/home/user/backups` (private, not web-served).

## Project layout

```
src/
  app.js               Express app factory (routes, rate limits, webhook)
  server.js            entrypoint; migrations, outbox timer, graceful shutdown
  config.js            environment-only configuration and startup validation
  db/                  connection (WAL, foreign keys) and migration runner
  db/migrations/       versioned SQL files (append-only)
  auth/                password hashing, server-side sessions
  middleware/          session loading, role checks, CSRF origin guard, errors
  services/            business logic: registration, login, outbox, audit, validation
  telegram/            Bot API client, signed callbacks, notifier
public/                static site (index.html, admin.html, assets/)
scripts/               set-admin-password, backup, verify-backup
tests/                 node:test suites (npm test)
docs/OPERATIONS.md     deployment, Telegram setup, backup and restore
```

## Quick start (development)

```bash
npm install
cp .env.example .env            # then edit values; for dev you may leave Telegram blank
export $(grep -v '^#' .env | xargs)   # or use your process manager
npm run migrate
printf '%s' 'YourStrongPass1' | npm run set-admin-password   # or run without piping for a hidden prompt
npm start                       # http://127.0.0.1:3000
npm test
```

See `docs/OPERATIONS.md` for production deployment, Telegram setup, backups and restoration.
