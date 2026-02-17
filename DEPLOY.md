# BodyBank — Deployment Checklist

## Before deploying

1. **Copy environment file**
   - Copy `.env.example` to `.env` and set all required values.

2. **Production environment**
   - Set `NODE_ENV=production`.
   - Set `ADMIN_PASS` to a strong password (default `admin123` is refused in production).
   - Set `SITE_URL` to your public URL (e.g. `https://yoursite.com`) for password-reset links.
   - Optionally set `ALLOWED_ORIGIN` to restrict CORS (e.g. `https://yoursite.com`).

3. **Database**
   - Set `DB_PATH` if the app should use a specific directory (e.g. persistent volume).
   - Ensure the directory exists and the process can read/write it.

4. **SMTP (optional)**
   - For “Forgot password” emails, set `SMTP_*` and `MAIL_FROM` in `.env`.

5. **Google Sign-In**
   - Set `GOOGLE_CLIENT_ID` in `.env` and add your deployment origin to the OAuth client.

## Run

```bash
npm install --production
node server.js
```

Or use a process manager (e.g. PM2, systemd) and ensure the process receives SIGTERM for graceful shutdown (DB is saved on exit).

## Health check

- `GET /api/health` — returns `{ ok: true, db: 'connected' }` when the app and database are ready.
