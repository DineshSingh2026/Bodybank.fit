# App Sync Log

Tracks which web changes have been propagated to the mobile apps (iOS + Android).
The mobile repo lives at `../bodybank-app/` (Capacitor wrapper for both platforms).

## How the sync works

The mobile repo bundles a frozen snapshot of this repo's `public/` into its own `www/` folder.
Backend changes (anything under `server.js`, `routes/`, etc.) deploy via Render and are reachable
from the app instantly — only **frontend** changes (HTML / CSS / JS / images) require a sync.

### Sync commands (run in `../bodybank-app/`)

```bash
npm run build:www          # mirror public/ -> www/ (skips public/videos/ by design)
npx cap sync android       # propagate www/ + native config to android/
npx cap sync ios           # propagate www/ + native config to ios/
git add www/ android/ ios/
git commit -m "chore: sync web vX.Y"
git push origin main
```

Codemagic builds the iOS IPA. Android can be built locally with:
`cd android && gradlew.bat bundleRelease`.

### Release checklist

Before every mobile release:
1. Pull latest of both repos.
2. Review the **Pending sync** section below.
3. Run the sync commands above.
4. Bump `versionCode` / `versionName` in `android/app/build.gradle`, `CFBundleShortVersionString` in `ios/`.
5. Commit + push the mobile repo.
6. Move the entries below into **History — synced** and clear Pending.

---

## Pending sync — next mobile release

_(empty — all up to date as of last entry in History)_

| Date | Web commit | Change | Notes |
| ---- | ---------- | ------ | ----- |

---

## History — synced

### 2026-06-01 — synced to mobile repo

| Web commit | Change | Notes |
| ---------- | ------ | ----- |
| `8fb1012` | feat: per-user AI access control + Success Stories video section | Admin: new Quick Access entry "🔐 Access Control" on dashboard. Backend endpoints already live via Render — no app rebuild needed for backend, only the UI bundle. |
| `28f500c` | feat(home): autoplay-on-scroll for Success Stories videos | IntersectionObserver-based, scoped to `#success-stories`. |
| _(this commit)_ | chore(app): videos served from web, not bundled in app | `bb-app-config.js` rewrites `/videos/*` to `https://www.bodybank.fit/videos/*`; `scripts/build-www.js` skips `public/videos/` during mirror. Saves ~24 MB in the IPA/APK. |

---

## Rules going forward

- **Backend-only change** (no files under `public/` modified) → no sync entry needed; the deployed Render backend serves both web and app.
- **Frontend change** under `public/` → add a row to **Pending sync** immediately, with the commit hash that introduced it.
- **New top-level folder under `public/` that's heavy** (large media, etc.) → consider adding it to `SKIP_TOP_LEVEL` in `bodybank-app/scripts/build-www.js` and rewriting the URL prefix in `bodybank-app/src-web/bb-app-config.js`.
