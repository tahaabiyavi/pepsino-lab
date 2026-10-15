# راهنمای دیپلوی

این پروژه یک اپلیکیشن **Node.js + Express + SQLite** است. چون پایگاه داده‌اش یک
فایل است، هر جا دیپلوی می‌کنی باید یک **فضای ذخیره‌سازی پایا (persistent volume/disk)**
داشته باشی — وگرنه با هر ری‌استارت همه چیز پاک می‌شود.

---

## متغیرهای محیطی

فایل `.env.example` را کپی کن و مقادیر را پر کن:

```bash
cp .env.example .env
```

### الزامی

| متغیر | توضیح |
|---|---|
| `PUBLIC_ORIGIN` | آدرسِ عمومیِ سایت. در حالت production **حتماً** باید با `https://` شروع شود (در غیر این صورت سرور بالا نمی‌آید). برای بررسی CSRF استفاده می‌شود. |
| `DB_PATH` | مسیر فایل پایگاه داده (مثلاً `/data/pepsino.sqlite`) |
| `DATA_DIR` | پوشه‌ی فایل‌های آپلودیِ خصوصی (پاسخ‌برگ‌ها، پاسخنامه‌ها) |

### اختیاری

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `PORT` | `3000` | پورت |
| `HOST` | `127.0.0.1` | در داکر/کانتینر باید `0.0.0.0` شود |
| `TRUST_PROXY` | `1` | تعداد لایه‌های پروکسی جلوی برنامه |
| `ADMIN_USERNAME` | `admin` | نام کاربریِ ادمین |
| `SESSION_TTL_HOURS` | `8` | عمر نشست در صورت عدم فعالیت |
| `SESSION_ABSOLUTE_HOURS` | `24` | عمرِ کل نشست |
| `APPEAL_WINDOW_DAYS` | `7` | مهلت ثبت اعتراض پس از انتشار نتایج |
| `TELEGRAM_*` | — | فقط برای تأیید ثبت‌نام از طریق تلگرام |

> **نکته:** `TELEGRAM_WEBHOOK_SECRET` و `TELEGRAM_CALLBACK_KEY` تنها زمانی الزامی‌اند که
> `TELEGRAM_BOT_TOKEN` تنظیم شده باشد. بدون توکن، مسیر وب‌هوک تلگرام ۴۰۴ می‌دهد.

---

## گزینه‌ی ۱: داکر (پیشنهادی برای VPS)

```bash
git clone https://github.com/tahaabiyavi/pepsino-lab.git
cd pepsino-lab
cp .env.example .env       # PUBLIC_ORIGIN و بقیه را پر کن
docker compose up -d
```

وضعیت:

```bash
docker compose logs -f
curl http://localhost:3000/healthz
```

---

## گزینه‌ی ۲: Render (یک‌کلیک)

فایل `render.yaml` در ریشه‌ی پروژه هست. در Render:

**New → Blueprint →** این مخزن را انتخاب کن.

دیسکِ پایا (`/var/data`) و رازها به‌صورت خودکار ساخته می‌شوند. فقط `PUBLIC_ORIGIN` را
خودت مقدار بده.

> توجه: دیسکِ پایا روی پلنِ رایگانِ Render در دسترس نیست؛ برای ذخیره‌ی واقعی به
> پلنِ Starter نیاز داری.

---

## گزینه‌ی ۳: نصب مستقیم روی سرور (بدون داکر)

```bash
# پیش‌نیازها: Node 20+ و ابزارهای ساخت برای better-sqlite3
sudo apt-get install -y python3 make g++

git clone https://github.com/tahaabiyavi/pepsino-lab.git
cd pepsino-lab
npm ci --omit=dev

cp .env.example .env       # مقادیر را پر کن
npm run migrate            # اعمال migrationها
npm run set-admin-password # تنظیم رمز ادمین (با prompt مخفی)

npm start
```

برای اجرای دائمی یک واحد systemd بساز (نمونه در `docs/OPERATIONS.md`).

---

## بعد از دیپلوی

۱. **رمز ادمین را تنظیم کن** — حساب ادمین با رمز وجود ندارد:

```bash
npm run set-admin-password          # روی سرور
docker compose exec app npm run set-admin-password   # با داکر
```

۲. **Reverse proxy** (Nginx/Caddy) جلوی برنامه بگذار تا TLS تمام شود، و
   `TRUST_PROXY` را با تعداد لایه‌ها هماهنگ کن.

۳. **پشتیبان‌گیری** — فایل پایگاه داده و `DATA_DIR` را مرتب backup بگیر
   (`BACKUP_DIR` و `BACKUP_RETENTION_DAYS` را در `docs/OPERATIONS.md` ببین).

---

## نکته‌ی امنیتی

- فایل‌های `.env`، پایگاه داده و `DATA_DIR` نباید هیچ‌وقت در دسترس وب باشند
  (`.gitignore` آن‌ها را مستثنا کرده است).
- `DATA_DIR` فایل‌های آپلودیِ دانش‌آموزان را نگه می‌دارد و فقط از طریق مسیرهای
  احراز‌هویت‌شده سرو می‌شود — آن را بیرون از وب‌روت نگه دار.
- برای تولیدِ واقعی، `SESSION_*` و رازهای تلگرام را با مقادیر تصادفیِ قوی پر کن:

```bash
openssl rand -hex 32
```
