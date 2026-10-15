# ---------------------------------------------------------------------------
# pepsino LAB — سامانه‌ی آزمون‌های تشریحی
# تصویرِ آماده برای هر جایی که داکر اجرا می‌شود (VPS، Fly.io، Railway، Coolify…)
#
# ساخت:      docker build -t pepsino-lab .
# اجرا:      docker run -p 3000:3000 -v pepsino-data:/data \
#              -e PUBLIC_ORIGIN=https://example.com \
#              -e TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32) \
#              -e TELEGRAM_CALLBACK_KEY=$(openssl rand -hex 32) \
#              pepsino-lab
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim

# better-sqlite3 یک ماژولِ بومی است و برای کامپایل به این ابزارها نیاز دارد
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# وابستگی‌ها را جداگانه نصب می‌کنیم تا لایه‌ی کشِ داکر بهتر عمل کند
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    TRUST_PROXY=1 \
    DB_PATH=/data/pepsino.sqlite \
    DATA_DIR=/data \
    BACKUP_DIR=/data/backups

RUN mkdir -p /data && chown -R node:node /data
USER node

# پایگاه داده و فایل‌های آپلودی اینجا زنده می‌مانند
VOLUME ["/data"]
EXPOSE 3000

# migrationها بی‌خطر و تکرارپذیرند؛ قبل از بالا آمدن سرور اجرا می‌شوند
CMD ["sh", "-c", "node src/db/migrate.js && node src/server.js"]
