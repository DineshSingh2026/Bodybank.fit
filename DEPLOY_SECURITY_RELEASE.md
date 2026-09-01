# Security release — Render configuration & deploy runbook

This release makes `JWT_SECRET` **mandatory in production**. The server now refuses to
start without it rather than sign tokens with a guessable key.

> **Set the environment variables BEFORE you deploy.**
> If you deploy first, the service will fail its health check and the old instance will
> stay live (Render keeps the previous deploy on failure), but you'll have a red deploy
> and no new code. Set the variables, then deploy — it takes two minutes.

---

## 1. Required — set these now

Render dashboard → **bodybank-fit** → **Environment** → *Add environment variable*.

| Key | Value | Why |
| --- | --- | --- |
| `JWT_SECRET` | `WmtzMZ-7HWj39D4GUHpE-vwbE1FesTeUwUYBfFkwjeVqoZ-4wKc364M9wcsLhrKe` | Signs every session token. Was unset, so tokens were signed with a constant published in the public repo. Must be ≥32 chars or the server refuses to boot. |
| `NODE_ENV` | `production` | Turns on HSTS, the 5xx error redaction, and the CORS allow-list. Without it the API reflects **any** origin. |
| `ALLOWED_ORIGIN` | `https://www.bodybank.fit,https://bodybank.fit` | The only origins allowed to make credentialed cross-origin calls. Comma-separated, no spaces, no trailing slash. |
| `ADMIN_PASS` | `BB-Adm-q5J7JJFblxxp` | No default exists any more. Under 12 characters and the admin is not seeded. |
| `SUPERADMIN_PASS` | `BB-Sup-UViSMQZLdoNR` | Same rule. Also replaces the removed `superadmin@gmail.com` backdoor. |
| `SUPERADMIN_EMAIL` | `superadmin@bodybank.fit` | Set explicitly so the account is deterministic. |
| `ADMIN_EMAIL` | `admin@bodybank.fit` | Also used as the fallback recipient for admin digests. |

**Rotating `JWT_SECRET` signs everyone out once.** That is the point — it invalidates
every token minted with the old published key. Users simply log in again.

The values above are freshly generated and unique to you. Nothing else has them.

---

## 2. Strongly recommended

| Key | Value | Why |
| --- | --- | --- |
| `NUTRITION_PHOTO_LINK_SECRET` | `dB6LEtptB61XasgpshqokYPdDMyonPTq56RzZYt-aEU` | HMAC key for signed meal-photo URLs. If unset, those links are signed with an empty key. |
| `RESET_BASE_URL` | `https://www.bodybank.fit` | Base for password-reset links. If unset in production it falls back to the request host, which an attacker can influence via the `Host` header. **Set it.** |
| `OPERATOR_EMAIL` | `operator@bodybank.fit` | Only needed if you use the operator role. |
| `OPERATOR_PASS` | `BB-Ops-_Y3-kvwmleG0` | Operator is only provisioned when both are set. |

---

## 3. Keep whatever you already have

These are unchanged by this release — don't touch them if they're already working:

`DATABASE_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
`SMTP_FROM`, `GOOGLE_CLIENT_ID`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`FIREBASE_SERVICE_ACCOUNT`, `ANTHROPIC_API_KEY`, `TWILIO_*`, `ADMIN_WHATSAPP*`,
`TRIAL_DAYS`, `APPLE_*`.

---

## 4. Optional — new knobs this release adds

| Key | Default | What it does |
| --- | --- | --- |
| `LOGIN_MAX_FAILURES` | `10` | Failed logins before an account is locked out. |
| `LOGIN_LOCKOUT_MS` | `900000` (15 min) | How long that lockout lasts. |
| `CSP_ENFORCE` | unset (report-only) | Leave unset. Set to `true` only after the inline scripts are migrated, or pages will break. |
| `API_ACCESS_LOG` | unset | Set `true` for method/path/IP logging on `/api/*`. No bodies, no query strings. |
| `UPLOADS_DIR` | `./uploads` | Now honoured consistently. Leave unset to keep today's behaviour. |

---

## 5. Safe to delete

| Key | Why |
| --- | --- |
| `CRON_SECRET` | Present in `.env` but read nowhere in the codebase. Dead configuration. |
| `SONET_API_KEY` / `SONNET_API_KEY` / `SONET_API_URL` / `SONET_MODEL` | Legacy names; the code uses `ANTHROPIC_API_KEY`. |

---

## 6. Deploy order

1. Add the variables in section 1 (and ideally 2). **Save.**
2. Render will auto-deploy on save, or on the next push to `main` — either is fine, as
   long as the variables are saved first.
3. Watch the deploy log. You are looking for:

   ```
   ✅ PostgreSQL connected
   ✅ DB ready | Admin: admin@bodybank.fit | Superadmin: superadmin@bodybank.fit
   ... | Env: production
   ```

   If instead you see:

   ```
   JWT_SECRET is not set. Refusing to start in production ...
   ```

   the variable didn't save. Fix it and redeploy — the old instance is still serving.

4. Smoke-test in this order:
   - `https://www.bodybank.fit/health` → `{"ok":true,"status":"live"}`
   - Log in as a member. **You will be signed out first — that's the key rotation.**
   - Log in as admin; open the dashboard, Members and Blood Reports tabs.
   - Log a workout and a meal.
   - Request a password reset and confirm the email arrives.

5. Confirm the fixes are live:

   ```bash
   # must be 401, not a database dump
   curl -s -o /dev/null -w "%{http_code}\n" https://www.bodybank.fit/api/admin/db-view

   # must be 401 — this used to return any user's profile
   curl -s -o /dev/null -w "%{http_code}\n" https://www.bodybank.fit/api/profile/any-id

   # must NOT return a token
   curl -s -X POST https://www.bodybank.fit/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"superadmin@gmail.com","password":"Bodybank@2026"}'
   ```

---

## 7. After a successful deploy

- **Rotate anything that reused the old superadmin password.** It is in public git
  history and stays readable even after this fix merges.
- Consider making the `Bodybank.fit` repository private. The mobile repo already is.
- Delete `SUPERADMIN_BOOTSTRAP_SECRET` from the environment once you've used it, if you
  ever set it. Suggested value if you need it: `r8vNuAmUzhwUQa-TFy0QDqQRTbm2hhPLFO2zFRT28oE`

## 8. Rolling back

Nothing in this release changes an API contract or a token format, so a rollback is a
plain Render "Redeploy previous". Two notes:

- The `feed_posts.user_id` column added here is nullable and additive — older code
  ignores it, so no data migration is needed either way.
- Password-reset tokens are now stored hashed. Rolling back leaves any hashed rows
  unusable; affected users just request a new reset link. Links issued before this
  deploy keep working for their normal 24 hours.
