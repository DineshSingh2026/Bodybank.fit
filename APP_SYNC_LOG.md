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

_(empty — synced 2026-06-17; see History below)_

---

## 2026-06-17 — synced to mobile repo (membership/trial onboarding, v1.3.5, versionCode 15)

Ran `node scripts/build-www.js` in `../bodybank-app/` (mirror `public/` → `www/`); bumped Android
`versionCode 14→15`, `versionName 1.3.4→1.3.5`. **Committed + pushed on branch
`feat/membership-trial-onboarding` in BOTH repos. Signed AAB built (versionCode 15, ~46 MB) at
`android/app/build/outputs/bundle/release/app-release.aab` — ready to upload to Play closed testing.**
Remaining manual steps: set `TRIAL_DAYS=30` on Render, merge web PR (→ Render deploy), upload AAB
(or merge mobile PR → Codemagic). Create PRs via the GitHub compare links (gh CLI not installed).

Backend (gate + admin endpoints + nightly cron in `server.js`) deploys via Render and reaches web + app
with no rebuild — only the **frontend** bundle (`public/index.html`) needed the www sync.

| Web change | What it is | Notes |
| ---------- | ---------- | ----- |
| _(this commit)_ | feat(membership): instant trial onboarding + manual-billing access control | `public/index.html`: new **Memberships** admin tab (Quick Access 💳) — trial/active/expiring/expired stats, call queue, one-click Activate (1/3/12mo/Lifetime), Trial +7d, WhatsApp, Lock. Sign-up success now shows "You're in! 🎉 7-day full access" instead of "pending approval". |
| _(this commit)_ | feat(membership) backend | `server.js`: `subscription_status`/`access_expires_at`/`plan_label`/`activated_*`/`trial_reminder_sent` columns; login access gate on email+Google+Apple; instant trial on all 3 sign-up paths; `/api/admin/memberships`, `/activate`, `/trial`, `/membership-lock`, `/memberships/run-lifecycle`; nightly lifecycle cron (00:30 IST). **Deploys via Render — no app dependency.** Existing users defaulted to `active`/no-expiry so nobody is locked out. |

**Closed-testing note:** set `TRIAL_DAYS` env on Render to a long value (e.g. 30–60) during testing so
testers are not auto-locked after 7 days; lower it to 7 for production pricing.

---

## 2026-06-15 — synced to mobile repo (v1.3.4, versionCode 14)

Ran `npm run build:release` in `../bodybank-app/` (build:www + cap sync android + signed `bundleRelease`); bumped Android `versionName 1.3.3→1.3.4`. **versionCode 12→13 was rejected by Play ("13 already used", likely a prior CI build) → bumped to 14** (mobile commit `f90dfc5`). Signed AAB at `android/app/build/outputs/bundle/release/app-release.aab` — **pending upload to Play Console closed-testing track.**

| Web commit | Change | Notes |
| ---------- | ------ | ----- |
| `cf751c0` | feat(nutrition): premium BodyBank × Fitchef redesign of Daily Check-in Food pane | `public/index.html` (co-branded hero w/ logo lockup + green/gold glow + live CoPowered chip + meals/streak stats; glass meal cards w/ per-meal icons + animated status bar + modern upload CTAs; inline meal thumbnails + macro pills + score). `public/sw.js` cache `v53→v54`. Frontend-only — no backend change. |

| Date | Web commit | Change | Notes |
| ---- | ---------- | ------ | ----- |

---

## History — synced

### 2026-06-13 — synced to mobile repo (Brain Tips mental-fitness release v1.3.3)

Ran `npm run sync` in `../bodybank-app/` (build:www + cap sync android); bumped Android `versionName 1.3.2→1.3.3` (versionCode is CI-derived: `PROJECT_BUILD_NUMBER + 100`). Codemagic `android-closed-testing` auto-builds the signed AAB and publishes to the Play **internal** closed-testing track on push to the mobile repo's `main`.

| Web commit | Change | Notes |
| ---------- | ------ | ----- |
| _(this commit)_ | feat(mind): Daily Check-in "Brain Tips" mental-fitness module (exact Beyond The Body replica) + branding | `public/index.html`: Body·Food·Mind segmented selector + dark BTB Brain Tips section (Box Breathing / 5-4-3-2-1 Grounding / Body Scan with guided players), Beyond The Body branding lockup + optimized logos in `public/img/`. `public/sw.js` cache `v52`→`v53`. Backend (`server.js` + `services/coinService.js`: `mind_checkins` table, `POST/GET /api/mind-checkin`, `MIND_CHECKIN` coins) deploys via Render — no app dependency. |

### 2026-06-11 — synced to mobile repo (Android nav fix release v1.3.1)

Ran `npm run sync` in `../bodybank-app/` (build:www + cap sync android); bumped Android `versionCode 9→10`, `versionName 1.3.0→1.3.1`. Built signed `app-release.aab` for closed-testing upload.

| Web commit | Change | Notes |
| ---------- | ------ | ----- |
| `c7d1cd1` | fix(nav): native Android app shows same floating pill bottom nav as PWA | `public/index.html` only — removed stale `html.android-mobile` bottom-nav overrides that fought the floating pill (stretched to 78px + safe-area, cramped icons/labels on the installed app). Pure CSS; required app re-sync + rebuild because `www/` bundles a frozen snapshot. |

### 2026-06-11 — synced to mobile repo (Android push release v1.3.0)

Ran `npm run sync` in `../bodybank-app/` (build:www + cap sync android); bumped Android `versionCode 8→9`, `versionName 1.2.1→1.3.0`.

| Web commit | Change | Notes |
| ---------- | ------ | ----- |
| _(native-push commit)_ | feat(push): native Android push via FCM | `public/index.html` adds `registerNativePush()`/`unregisterNativePush()` (guarded by `window.IS_BODYBANK_APP`), called after login (`openUserDashboard`, `restoreSession`) and on logout. Mobile repo gains `@capacitor-firebase/messaging@7.5.0`. **Needs `google-services.json` in `android/app/` to build, and `FIREBASE_SERVICE_ACCOUNT` env on Render to send.** Backend (`server.js`) FCM send path deploys via Render — no app dependency. |
| _(prior commit)_ | fix(auth): resilient Google Sign-In load (retry, no blocking popup) | `public/index.html`. Now in this `www/` snapshot. |
| _(prior commit)_ | chore(push): brand + emoji notification titles; `sw.js` `Body Bank`→`BodyBank`, cache `v51`→`v52` | `public/sw.js` fallback only; actual titles are backend-driven. Now in this `www/` snapshot. |

### 2026-06-01 — synced to mobile repo

| Web commit | Change | Notes |
| ---------- | ------ | ----- |
| `8fb1012` | feat: per-user AI access control + Success Stories video section | Admin: new Quick Access entry "🔐 Access Control" on dashboard. Backend endpoints already live via Render — no app rebuild needed for backend, only the UI bundle. |
| `28f500c` | feat(home): autoplay-on-scroll for Success Stories videos | IntersectionObserver-based, scoped to `#success-stories`. |
| _(this commit)_ | chore(app): videos served from web, not bundled in app | `bb-app-config.js` rewrites `/videos/*` to `https://www.bodybank.fit/videos/*`; `scripts/build-www.js` skips `public/videos/` during mirror. Saves ~24 MB in the IPA/APK. |
| _(this commit)_ | feat(home): replace FitChef Arsenal demo cards with 3 real client meal cards | Removed 5 mock images (`breakfast.png`, `lunch.png`, `meal-snack.png`, `Dinner.png`, `bodybank nutrition kanshika1.png`). Added 3 real client cards in `public/img/fitchef meals/` (Akshaya Ragi Malt, Abhinav Overnight Oats, Abhinav Omelette). |

---

## Rules going forward

- **Backend-only change** (no files under `public/` modified) → no sync entry needed; the deployed Render backend serves both web and app.
- **Frontend change** under `public/` → add a row to **Pending sync** immediately, with the commit hash that introduced it.
- **New top-level folder under `public/` that's heavy** (large media, etc.) → consider adding it to `SKIP_TOP_LEVEL` in `bodybank-app/scripts/build-www.js` and rewriting the URL prefix in `bodybank-app/src-web/bb-app-config.js`.
