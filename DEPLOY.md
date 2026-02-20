# BodyBank — Deployment Checklist

## Before deploying

1. **Copy environment file**
   - Copy `.env.example` to `.env` and set all required values.

2. **Production environment**
   - Set `NODE_ENV=production`.
   - Set `ADMIN_PASS` to a strong password (default `admin123` is refused in production).
   - Set `SUPERADMIN_EMAIL` and `SUPERADMIN_PASS` for the business-overview dashboard (default superadmin password is refused in production).
   - Set `JWT_SECRET` to a long random string (recommended for auth and share-link tokens).
   - Set `SITE_URL` to your public URL (e.g. `https://yoursite.com`) for password-reset links.
   - Optionally set `PUBLIC_URL` for superadmin share links (e.g. `https://your-app.onrender.com`).
   - Optionally set `ALLOWED_ORIGIN` to restrict CORS (e.g. `https://yoursite.com`).

3. **Database**
   - Set `DATABASE_URL` to your PostgreSQL connection string (e.g. `postgresql://user:pass@host:5432/bodybank`).
   - To migrate from an existing SQLite file: set `DB_PATH`, run `node scripts/migrate-sqlite-to-postgres.js`, then start the app with `DATABASE_URL`.

4. **Google Sign-In**
   - Set `GOOGLE_CLIENT_ID` in `.env` and add your deployment origin to the OAuth client.

## Run

```bash
npm install --production
node server.js
```

Or use a process manager (e.g. PM2, systemd). PostgreSQL is persistent; no file save on exit.

## Health check

- `GET /api/health` — returns `{ ok: true, db: 'connected' }` when the app and database are ready.
