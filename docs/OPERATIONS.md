# Operations guide

## 1. Server prerequisites
- Ubuntu/Debian VPS, Node.js 20 LTS or newer, build tools (for better-sqlite3's native module if no prebuilt binary is available: `sudo apt install -y build-essential python3`).
- Nginx (or Caddy) in front for TLS. Port 3000 must NOT be exposed publicly.
- A dedicated system user, e.g. `pepsino`.

```bash
sudo adduser --system --group --home /opt/pepsino-lab pepsino
sudo mkdir -p /var/lib/pepsino-lab /var/backups/pepsino-lab
sudo chown pepsino:pepsino /var/lib/pepsino-lab /var/backups/pepsino-lab
sudo chmod 700 /var/lib/pepsino-lab /var/backups/pepsino-lab
```

## 2. Deploy
```bash
sudo -u pepsino git clone <repo> /opt/pepsino-lab      # or copy the release folder
cd /opt/pepsino-lab
sudo -u pepsino npm ci --omit=dev
sudo -u pepsino cp .env.example .env && sudo chmod 600 .env   # then edit .env
sudo -u pepsino npm run migrate
sudo -u pepsino npm test   # optional: run the suite before going live
```

Set the administrator password (hidden prompt, never stored in .env):
```bash
cd /opt/pepsino-lab && sudo -u pepsino env $(grep -v '^#' .env | xargs) npm run set-admin-password
```
Changing the admin password revokes all admin sessions.

## 3. systemd service (`/etc/systemd/system/pepsino-lab.service`)
```ini
[Unit]
Description=pepsino LAB
After=network.target

[Service]
Type=simple
User=pepsino
WorkingDirectory=/opt/pepsino-lab
EnvironmentFile=/opt/pepsino-lab/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/pepsino-lab /var/backups/pepsino-lab
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now pepsino-lab
```

## 4. Nginx (TLS termination; add your certificate with certbot)
```nginx
server {
  listen 443 ssl http2;
  server_name pepsinogen.net;
  client_max_body_size 1m;           # app-level JSON limit is 32 KB; file uploads will raise this per route later
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
Keep `TRUST_PROXY=1` and `PUBLIC_ORIGIN=https://…` in `.env`. The app refuses to start in production without an https origin and the Telegram secrets.

## 5. Restart, status and logs
```bash
sudo systemctl restart pepsino-lab     # safe: pending notifications resume from SQLite
sudo systemctl status pepsino-lab
journalctl -u pepsino-lab -n 200 --no-pager
curl -s http://127.0.0.1:3000/healthz  # {"ok":true}
```
Stopping is graceful: the server closes HTTP, checkpoints the WAL, then exits.

## 6. Backups (mandatory)
Run daily via cron as the service user:
```cron
15 3 * * * cd /opt/pepsino-lab && env $(grep -v '^#' .env | xargs) /usr/bin/node scripts/backup.js >> /var/log/pepsino-backup.log 2>&1
```
- `scripts/backup.js` makes an online consistent snapshot (safe while the app runs), runs `PRAGMA integrity_check`, counts key tables, writes a SHA-256 manifest, and applies `BACKUP_RETENTION_DAYS` (default 14). The newest backup is never deleted.
- Backups live in `$BACKUP_DIR/db/`, outside the web root, with mode 0600.
- Copy backups off the VPS as well (for example `rsync` to another machine or object storage). A backup on the same disk does not protect against disk loss.
- Uploaded files (not yet implemented) will be backed up with the same schedule when that feature is added.

Verify a backup at any time:
```bash
node scripts/verify-backup.js /var/backups/pepsino-lab/db/pepsino-<stamp>.sqlite
```
A backup is only considered usable when this prints `checksum: ok` and `"integrity": "ok"`.

## 7. Restore procedure
1. Stop the service: `sudo systemctl stop pepsino-lab`.
2. Keep the damaged database for forensics: `mv /var/lib/pepsino-lab/pepsino.sqlite{,.damaged}` and remove any `-wal` / `-shm` files.
3. Verify the chosen backup (section 6).
4. Copy it into place: `cp <backup>.sqlite /var/lib/pepsino-lab/pepsino.sqlite && chown pepsino: … && chmod 600 …`
5. Run `npm run migrate` (safe: applies only missing migrations).
6. Start the service and check `/healthz` and an admin login.
7. Write an audit note. Users who registered after the backup time must register again. Their notifications may be re-sent, and that is expected.

## 8. Migrations
- Migration files live in `src/db/migrations/NNN_name.sql` and are applied in order inside a transaction. A failed migration rolls back and leaves the database unchanged.
- Never edit an applied migration. Add a new numbered file instead.
- Before any migration in production: run a backup and verify it (section 6).

## 9. Telegram setup
1. In Telegram, open **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Find each authorized administrator's **numeric** Telegram user ID (for example by messaging @userinfobot). Put the IDs in `TELEGRAM_ADMIN_IDS=111,222`. Only listed IDs can approve or reject. Being the shared website admin does not grant Telegram rights.
3. Create a private chat with the bot (or a group the bot is in) and get its chat ID. Put it in `TELEGRAM_ADMIN_CHAT_ID`. For a group, the ID is negative.
4. Generate two random secrets and put them in `.env`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # use for TELEGRAM_WEBHOOK_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # use for TELEGRAM_CALLBACK_KEY
   ```
5. Register the webhook (the secret token must match `TELEGRAM_WEBHOOK_SECRET`):
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://pepsinogen.net/api/telegram/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
     -d 'allowed_updates=["message","callback_query"]'
   ```
6. Restart the service. Send `/pending` to the bot from an authorized account to list waiting requests.

If Telegram is down or misconfigured: registrations are still saved. Check the failed count in the admin console and press **ارسال مجدد** after fixing the problem. Notifications that fail 8 times are marked `failed` and are retried only by an admin action.

## 10. Admin password reset
```bash
cd /opt/pepsino-lab && sudo -u pepsino env $(grep -v '^#' .env | xargs) npm run set-admin-password
```
This overwrites the hash and revokes every admin session. Share the new password only with trusted people. The application cannot identify which person used the shared account, so the audit log records the actor as `admin`.

## 11. Security checklist before go-live
- [ ] `.env` is mode 600 and owned by the service user; it is not in any web directory.
- [ ] Port 3000 is not reachable from the internet (`ss -ltnp`).
- [ ] `PUBLIC_ORIGIN` is the exact https origin.
- [ ] Old `/api/state` on the legacy site has been disabled and the exposed password rotated.
- [ ] Telegram webhook secret and callback key are set; `TELEGRAM_ADMIN_IDS` lists only authorized people.
- [ ] Daily backup runs, and `verify-backup.js` succeeds on the latest file.
- [ ] A restore has been rehearsed on a second machine or directory.

## Answer-sheet uploads (added with migration 003)

- **nginx must allow at least 11 MB request bodies** for the upload routes. The
  application enforces the 10 MB per-file limit itself, and multipart overhead
  needs headroom:

  ```nginx
  client_max_body_size 11m;
  ```

  Without this, nginx returns 413 before the request reaches the app.
- Files are stored under `DATA_DIR/private/uploads/YYYY-MM/<random>.bin`. The
  directory is never served statically. Downloads go through authenticated
  routes only, with `Content-Disposition: attachment`, `nosniff` and
  `Content-Security-Policy: sandbox`.
- Back up `DATA_DIR/private` together with the database. The SQLite backup
  alone does not contain the files. A file backup script is **not yet written**
  (see IMPLEMENTATION_STATUS.md).
- Upgrade procedure used for migration 003 (rehearsed on a copy with data):
  1. Stop the service or confirm no writes are in progress.
  2. `node scripts/backup.js` and `node scripts/verify-backup.js <file>`.
  3. Start the service. Migrations run in a transaction, and the sessions table is rebuilt in place (rows are copied).
  4. Check `/healthz` and log in as admin.

## Backups (complete set)

A complete backup needs both parts:

1. Database: `node scripts/backup.js` (verified with `scripts/verify-backup.js`).
2. Private files: `node scripts/backup-files.js`. It copies every file under
   `DATA_DIR/private`, verifies each copy with SHA-256, writes `manifest.json`,
   and reports any file the database references but that is missing on disk.
   The command exits with status 1 when verification fails or a file is missing.

Restore order: restore the database first, then the files. Run
`scripts/backup-files.js` again afterwards to confirm the restored set matches.

## Scheduler

`src/server.js` runs the publication tick every 60 seconds. Each tick:
closes submission windows, releases answer keys, publishes results (only when
every sheet is finalized), emits publication notifications, and removes
pending uploads whose window has ended. Every step is idempotent.

## Settings added with migration 004

- `DATA_DIR`: location of private uploads. Keep it outside the web root.
- `APPEAL_WINDOW_DAYS`: appeal window in days after results are published (default 7).

## Grader answer key (policy decided)

Graders may open the official answer key for any exam they hold a sheet of,
from the moment of assignment and before publication. Access ends when that
sheet is reassigned away. Each view is recorded in the audit log.
Endpoint: `GET /api/grader/exams/:examId/answer-key` (add `?inline=1` to display in the browser).
Students still receive the key only after the scheduler publishes it.
