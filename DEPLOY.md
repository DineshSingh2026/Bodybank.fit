# BodyBank — Deployment Checklist

**Repo:** [Bodybank.fit](https://github.com/DineshSingh2026/Bodybank.fit) — ready for manual deploy. Use branch **`main`**. Render will use `render.yaml` from the repo root.

## Cache busting — users see new version after deploy

**On each deploy**, bump the app version so users/admins get the latest UI instead of cached old versions:

1. **`public/sw.js`** — change `CACHE_NAME` (e.g. `bodybank-v11` → `bodybank-v12`)
2. **All HTML files** that link CSS — change `?v=11` → `?v=12` in:
   - `public/index.html` (2 links)
   - `public/tribe-stories.html`, `public/our-story.html`, `public/part2-form.html`, `public/progress-report.html` (2 links each)

The service worker will then install the new version, clear old caches, and the page will auto-reload (or users can tap the refresh button). CSS cache-bust ensures styles update immediately.

## Before deploying

1. **Copy environment file**
   - Copy `.env.example` to `.env` and set all required values.

2. **Production environment**
   - Set `NODE_ENV=production`.
   - Set `ADMIN_PASS` to a strong password (default `admin123` is refused in production).
   - Set `SUPERADMIN_EMAIL` and `SUPERADMIN_PASS` for the business-overview dashboard (default superadmin password is refused in production).
   - Set `JWT_SECRET` to a long random string (recommended for auth and share-link tokens).
   - On Render, password-reset links use `RENDER_EXTERNAL_URL` automatically. For a custom domain, set `RESET_BASE_URL` or `SITE_URL` (e.g. `https://yoursite.com`).
   - Optionally set `PUBLIC_URL` for superadmin share links (e.g. `https://your-app.onrender.com`).
   - Optionally set `ALLOWED_ORIGIN` to restrict CORS (e.g. `https://yoursite.com`).

3. **Database**
   - Set `DATABASE_URL` to your PostgreSQL connection string (e.g. `postgresql://user:pass@host:5432/bodybank`).
   - To migrate from an existing SQLite file: set `DB_PATH`, run `node scripts/migrate-sqlite-to-postgres.js`, then start the app with `DATABASE_URL`.

4. **Google Sign-In**
   - Set `GOOGLE_CLIENT_ID` in `.env` and add your deployment origin to the OAuth client.

5. **Admin AI (live server / optional)**
   - To enable Claude Sonnet answers in the Admin dashboard, set `ANTHROPIC_API_KEY`.
   - On Render: Dashboard → your Web Service → Environment → Add `ANTHROPIC_API_KEY` (value = `sk-ant-...`), then Save (app will redeploy).
   - Optional: `ANTHROPIC_MODEL=claude-sonnet-4-5`.

## Run

```bash
npm install --production
node server.js
```

Or use a process manager (e.g. PM2, systemd). PostgreSQL is persistent; no file save on exit.

## Health check

- `GET /api/health` — returns `{ ok: true, db: 'connected' }` when the app and database are ready.
