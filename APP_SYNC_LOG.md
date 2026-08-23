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

_Nothing pending — `www/` verified byte-identical to `public/` as of web commit `c727f4e` (2026-08-23, during the API 36 release)._

---

## 2026-08-23 — Android 16 (API 36) compliance release, v1.7.2, versionCode 100

**No web content in this release.** `www/` was verified byte-identical to `public/` before
building — every file difference was the injected `bb-app-config.js` tag (19 HTML files) plus
the deliberate `videos/` + `reports/` skips. Nothing was re-synced; only `android/` changed.

**Why:** Google Play blocks *updates* from **Aug 31, 2026** unless the app targets API 36.
The live v1.7.1 build is not pulled — but no further update can ship until a 36-targeted
build reaches production.

| File | Change |
| ---- | ------ |
| `android/variables.gradle` | `compileSdkVersion` + `targetSdkVersion` 35 → 36 |
| `android/build.gradle` | AGP 8.7.2 → 8.10.1 |
| `android/app/build.gradle` | `versionCode` 30 → 100, `versionName` 1.7.1 → 1.7.2 |

**AGP had to move too.** 8.7 was only tested to `compileSdk 35` and warns on 36. AGP 8.10
requires Gradle 8.11.1 minimum, which the wrapper already pins — so no wrapper change.
AGP 8.11+ would have forced Gradle 8.13; deliberately avoided.

**Behaviour changes were checked, not assumed:**

- **Edge-to-edge** — the usual hazard, already absorbed at API 35. Capacitor 7.6.5 defaults
  `adjustMarginsForEdgeToEdge: "auto"`, which insets the WebView on every API 35+ device
  today ([`CapacitorWebView.java:58`]). API 36 only stops honouring the opt-out flag, which
  this app never set. No visual change expected.
- **16 KB page size** — no `.so` files anywhere in the build. Pure WebView app, not applicable.
- **Large-screen orientation/resize locks ignored** — manifest sets no `screenOrientation`
  or `resizableActivity`, so there is nothing to lose. On tablets the app becomes freely
  rotatable/resizable, which a responsive web app handles.
- **Predictive back** — on by default at target 36, but there is no `@capacitor/app` plugin
  and no `onBackPressed` override, so back already just finishes the activity. What changes
  is the system close animation, not the behaviour.

**Build verified, not assumed:** `BUILD SUCCESSFUL in 4m 38s`, 312 tasks, zero warnings.
Merged manifest reads `targetSdkVersion="36" versionCode="100" versionName="1.7.2"`.
AAB signed — `jar verified`, `CN=BodyBank, OU=Mobile`. All six Capacitor plugins read
`rootProject.ext`, so they compiled against 36 as well.

> **versionCode 100 was chosen against Codemagic's range, not arbitrarily.** `codemagic.yaml`
> builds Android with `ANDROID_VERSION_CODE=$PROJECT_BUILD_NUMBER + 100`, i.e. **101 and up**.
> Sitting at 100 keeps the sequence monotonic whichever way the next build is produced.
> **Check Play Console for the highest existing versionCode before hand-uploading** — if CI
> has already pushed builds at 101+, a manual 100 will be rejected as *lower*, which is the
> most likely explanation for the 13/17/24 collisions in earlier releases.

> **Pushing `main` on the mobile repo auto-publishes.** The `android-closed-testing` workflow
> triggers on every push to `main` and submits straight to the Play `internal` track with
> `submit_as_draft: false`. Pushing is therefore a release action, not just a code action.

---

## 2026-08-23 — synced to mobile repo (**first production release**, v1.7.1, versionCode 30)

Ran `npm run build:www` + `npx cap sync android`; bumped Android `versionCode 23→30`,
`versionName 1.7.0→1.7.1`. `public/sw.js` cache `v71→v72`. Web commit `100b00c`.

> **versionCode 24 was rejected by Play as already used** — the third such collision
> (13 → 14, 17 → 18, now 24 → 30). Something outside the local build consumes codes in
> this range, so this release **jumps to 30** rather than creeping to 25 and risking
> another round trip. Gaps are harmless: versionCode is opaque to users, only
> versionName is shown. If the next release collides again, jump further, and treat any
> number below ~100 as suspect.

This is the build promoted to the Play **production** track — every prior entry in this log
shipped to closed testing only.

**Bundle verified before building, not assumed.** Diffed `bodybank/public/` against
`bodybank-app/www/` file by file: the only differences were the injected
`bb-app-config.js` tag (19 HTML files), the deliberate `videos/` + `reports/` skips,
`www/__smoke.html`, and `www/js/bb-app-config.js`. The single content difference was
`index.html`, carrying exactly the hero change below. Everything from v1.7.0 and earlier
was already in the tree.

| Area | What changed |
| ---- | ------------ |
| Hero | Dropped the "no account needed / create your account" line under the audit button, and its twin above the repeat CTA. Join sits in the header now, so the hero says one thing |

> **sw cache caught here, not in the app:** `100b00c` changed `public/index.html` without
> bumping `CACHE_NAME`, so web/PWA visitors would have kept serving the stale hero from
> cache. Bumped `v71→v72` as part of this release. The app is unaffected either way —
> `bb-app-config.js` stubs out service-worker registration.

> **Backend note:** no server half in this release. The endpoints the v1.7.0 landings depend
> on (`/api/member/home`, `/api/admin/overview`, `/api/operator/overview`,
> `/api/operator/clients`, `/api/operator/blood`) are already live on Render. Still
> **confirm the Render deploy of web `main` is green before promoting**, since production
> users have no earlier build to fall back to.

> Capacitor plugin set unchanged from v1.4.0 — 6 plugins, no new native permissions.

---

## 2026-08-20 — synced to mobile repo (joining made findable, check-in + consultations hardened, v1.7.0, versionCode 23)

Ran `npm run sync`; bumped Android `versionCode 22→23`, `versionName 1.6.0→1.7.0`.
`public/sw.js` cache `v70→v71`. Web commit `11d0eeb`, mobile commit `94b7610`.
Also carried the member-home and operator-console work from `364aea6`, which had
not been synced.

All of the below is frontend, so it needed the sync. The daily check-in and
consultation work also has a server half, which reaches the app through Render on
deploy — the app only needed the new screens.

| Area | What changed |
| ---- | ------------ |
| Daily check-in | Bounds on steps / water / protein / sleep (a 6851-hour night used to save), and today-only editing of an entry that was previously write-once |
| Consultations | Past dates and passed slots are refused, slots show as booked, rescheduling added, and the member has a list with real status. Booking is now authenticated and owner-scoped |
| Sign-up | Country is a dropdown of 204 countries and the phone dialling code follows it; one sign-up form (/signup) instead of a page and a modal |
| Mobile menu | Rebuilt: it could not scroll and was painted over at both ends by the header and the bottom bar. Now one shared stylesheet across all four public pages |
| Join / Login | Both visible in the header at every width. The bottom bar's "Join" used to open the LOGIN modal — it now goes to /signup, and the duplicate tab is gone |
| Header | Fixed nav links overlapping the tagline between ~900 and 1400px; slimmer mobile bar |

---

## 2026-08-19 — synced to mobile repo (staff + member landings rebuilt, v1.6.0, versionCode 22)

Ran `npm run build:www` + `npx cap sync android`; bumped Android `versionCode 21→22`,
`versionName 1.5.1→1.6.0`. `public/sw.js` cache `v68→v69`.

The largest sync since v1.4.0 — every role's landing screen was rebuilt, and three
backend subsystems landed behind them.

| Web commit | What it is |
| ---------- | ---------- |
| `a6ea5ac` | Whoop **Signal engine** — deterministic laws/directive/bloodwork bridge over Whoop + BodyBank data. Member/staff split is a server-side whitelist. |
| `da5786a` | Blood reports ordered by lab **draw date**, full operator parity |
| `d7f9558` | Admin mobile dashboard rebuild; Signal + blood-report UI wired |
| `f77b96f` | Operator console rebuild, editable progress report, **AI token ledger** |
| `b718339`…`13d0fbf` | Operator console rebuilt in the Aurora direction, around clients |
| `819cb1e`…`8cb64da` | Operator **Overview landing**; hero shows active-client engagement |
| `98c80c0` | Operator monitoring numbers, each one a filter into the client list |
| `621d35e`…`ee3991b` | Operator fixes: Elite card z-order, reel avatars, sign-out on a phone |
| `24dc3f7`, `e2ce8fc` | Admin **Dashboard landing** rebuilt around one read, quick access restored |
| `e538d3a`, `c78279a` | Pipeline: **No reply** stage, members made visible, tick-and-move, usable on a phone |
| `7fa2bf7`, `7d3e6d1` | Landing numbers made exact, and the same label made to mean the same number on both landings |
| `e456559`…`d3c115d` | **Member home** rebuilt around the daily loop + blood/Whoop uploads, then sequenced into one page |

> **Backend note:** this release leans on endpoints that ship with the web repo, not the
> bundle — `/api/member/home`, `/api/admin/overview`, `/api/operator/overview`,
> `/api/operator/clients`, `/api/operator/blood` and the blood-editor routes. They reach the
> app only once Render has deployed web `main`. **Confirm the Render deploy is green before
> promoting this build**, or the new landings will load empty against the old server.

> **How this actually ships:** the signed AAB is built **locally** and uploaded to Play by
> hand — `cd android && gradlew.bat bundleRelease`, signed from `android/keystore.properties`
> (gitignored). That is why Play's versionCode tracks the literal in `android/app/build.gradle`
> (20 → 21 → 22) rather than Codemagic's `PROJECT_BUILD_NUMBER + 100`. The
> `android-closed-testing` workflow in `codemagic.yaml` is configured but is not the live
> path; pushing `main` alone does **not** put a build in Play. Built for this release on
> 2026-08-19: `android/app/build/outputs/bundle/release/app-release.aab` (45.4 MB,
> versionCode 22 / versionName 1.6.0, sw cache v69).

> **Rule applied from v1.5.1:** home-screen work must land in both `.user-welcome` (mobile)
> and `.bb-user-desktop-dashboard` (desktop ≥768px). The member home goes further and
> *retires* both panes, moving their widgets into one sequenced page — so the two surfaces
> can no longer drift.

---

## 2026-08-12 — synced to mobile repo (readiness on desktop web, v1.5.1, versionCode 21)

Ran `npm run build:www` + `npx cap sync android` + `npx cap copy ios`; bumped Android
`versionCode 20→21`, `versionName 1.5.0→1.5.1`. `public/sw.js` cache `v67→v68`.

| Web commit | What it is | Notes |
| ---------- | ---------- | ----- |
| `8913844` | fix(whoop): show readiness on desktop web, not just mobile | The v1.5.0 readiness card only ever appeared on mobile. It sits in the Today hero inside `.user-welcome`, which the desktop home swap hides wholesale at ≥768px in favour of `.bb-user-desktop-dashboard` — a separate pane that never got a card. On desktop a member saw nothing, and had no entry point either (the ⌚ Readiness pill is in the same hidden hero), so importing a Whoop export from a desktop browser was impossible. Adds a desktop card and makes `bbRdHomeLoad`/`renderHomeCard` fill **every** `.bb-rd-card` instead of a single `#bbRdHome`, so the two surfaces cannot drift. |

> **Why this was missed in v1.5.0:** the frontend recon explicitly reported "the Today hero is
> **not** duplicated — one instance only, so one insertion suffices". True as stated, but it
> missed that the hero is mobile-only. Any future home-screen work must land in **both**
> `.user-welcome` (mobile) and `.bb-user-desktop-dashboard` (desktop ≥768px).

Admin and operator needed no change — they were already correct at every width. Both are
sub-tabs, which is why they read as missing: **Admin → Client Progress → select a client →
Readiness**, and **Operator → client detail → Readiness**.

---

## 2026-08-11 — synced to mobile repo (Whoop readiness product, v1.5.0, versionCode 20)

Ran `npm run build:www` + `npx cap sync android` + `npx cap copy ios`; bumped Android
`versionCode 19→20`, `versionName 1.4.0→1.5.0`. Signed AAB at
`android/app/build/outputs/bundle/release/app-release.aab`.

Frontend-only sync — the backend (new tables, endpoints, PDF ingestion) deploys via Render and
reaches web + app with no rebuild. `public/sw.js` cache `v66→v67` (inert in the app, which stubs
out service-worker registration).

| Web commit | What it is | Notes |
| ---------- | ---------- | ----- |
| `955a77e` | feat(whoop): surface the readiness product | The Whoop engine was complete and unreachable — a member could import their whole history and nothing appeared. Adds the Today-screen readiness card, a 7/30/90-day detail view, the AI report and branded PDF (both endpoints already existed and had never been called), derived readiness for members *without* Whoop, and per-client readiness/workouts/journal for admin **and** operator. New `wearable_workouts` + `wearable_journal` tables stop the import silently discarding every workout and journal entry. Prefill batched (was ~2,200 sequential round-trips per import — a Render timeout). PDF import via `whoopPdfExtract.js`. |

**App-specific notes**

- The readiness PDF download uses the same detached-anchor `blob:` + `<a download>` pattern as
  the blood-report download, so the native download bridge added in v1.4.0 intercepts it. Any
  other approach (`window.open`, a direct href to an API URL) silently does nothing in the app —
  this was checked explicitly during review.
- No new Capacitor plugins; the v1.4.0 plugin set is unchanged.
- The Whoop upload input now accepts `.pdf` alongside `.zip`/`.csv`. Capacitor maps the extension
  to `application/pdf` for the SAF picker, so PDF selection works in-app.

**Verified before release:** 578 unit checks, the full e2e suite, and a live import over HTTP
against a real Postgres (preview writes nothing; commit persists 11 days / 7 workouts / 9 journal
entries; re-upload is a no-op; cross-member reads refused; stats-only PDF renders real bytes).
**Not verified:** PDF ingestion against a genuine Whoop PDF — the extractor is unit-tested with a
stubbed model and no live Claude call has been made through it.

---

## 2026-08-10 — synced to mobile repo (six-week catch-up release, v1.4.0, versionCode 19)

Ran `npm run build:www` + `npx cap sync android` + `npx cap copy ios` in `../bodybank-app/`;
bumped Android `versionCode 18→19`, `versionName 1.3.7→1.4.0`. This closes the gap from web
commit `bcf00c4` (last synced) up to `23685c7` — everything in the **user**, **admin** and
**operator** surfaces is now in the app bundle.

### Native change in this release — download bridge

Every "download" in the web app builds a `Blob`, wraps it in `URL.createObjectURL()` and clicks
a hidden `<a download>`. Android's WebView has no download manager wired up by Capacitor, and a
`blob:` URL cannot be handed to the native `DownloadManager` anyway — so **inside the app those
clicks silently did nothing.** That broke the blood-report PDF, the progress-report PDF, all four
admin status-dashboard CSV exports, the nutrition/leaderboard CSVs, and the meal/share card saves.

`src-web/bb-app-config.js` now intercepts `a[download]` clicks (both `a.click()` from code and
real taps), resolves the Blob, writes it to the app cache via `@capacitor/filesystem`, and opens
the native share sheet via `@capacitor/share` so the user can save it to Files/Drive or open it
in a PDF viewer. `URL.createObjectURL`/`revokeObjectURL` are wrapped so the Blob survives the
call sites that revoke on the very next line. Web/PWA behaviour is untouched — the whole block is
inside the `isNativeApp()` guard.

New deps: `@capacitor/filesystem@7.1.8`, `@capacitor/share@7.0.4`. Neither adds a manifest
permission; Share reuses the FileProvider + `res/xml/file_paths.xml` (`cache-path`) already
declared for the app. Codemagic's iOS lane runs `npx cap sync ios`, so the pods install there
automatically.

| Web commit | What it is | Notes |
| ---------- | ---------- | ----- |
| `23685c7` | feat(referrals+whoop): referral programme and Whoop readiness integration | Member Rewards modal (invite link, copy/WhatsApp share, coin redemption), Whoop `.zip`/`.csv` import, admin **Referrals** tab. Share URL is server-built from the public origin, so it stays `bodybank.fit` inside the app. Whoop is a file import — no OAuth, no deep link needed. |
| `858238c` | feat(checkin): drop Full Name from Sunday form, compact status dashboard rows | Frontend only. |
| `f0aa310` | feat(admin): status dashboards for Daily check-in, Audit form and Part-2 | Adds three CSV exports — **these needed the download bridge above.** |
| `e33edd6` | feat(admin): Sunday check-in status dashboard + contact phone search | Adds a CSV export. |
| `121de5d` | feat(blood): longitudinal report comparison + member progress view | Admin progress-review workspace + branded Progress PDF download. |
| `cd05b7a` | feat(auth): standalone /signin and /signup pages | New `public/signin.html`, `public/signup.html`, `css/auth-pages.css`, `js/auth-pages.js` — bundled into `www/` and given the app-config injection. Not reachable in-app (the app boots `index.html`), but shipped so the tree stays a faithful mirror. |
| `8c657a1` | feat(admin): Export CSV on Part-2 forms tab | Download bridge. |
| `fa9961b` | fix(operator): stop action-button label overlap in client-detail modal | |
| `478cc44` | fix(admin): scrollable lead modal, client-grouped form lists, reliable meal-image download | |
| `3d84445` / `85b29bc` | feat(blood): admin **and** operator can upload + process a client's blood report | `<input accept=".pdf,image/*">` — Capacitor maps the `.pdf` extension to `application/pdf` for the SAF picker, so PDF selection works in-app. |
| `f6f89e7` | feat: remove AI Coach entirely | Reverses `6a91446` + `a242d2d`; net effect on the bundle is removal. |
| `d01fb65` | feat(onboarding): first-sign-in app guide + re-openable "?" button | |
| `7af6bfb` / `6b5faf2` | feat(blood): branded PDF + 3 upload slots + operator report access | The PDF download is the headline reason for the download bridge. |
| `fbe5a01` `badf400` `d08852b` `14a320c` `c107343` | feat/fix(operator): read-only monitoring dashboard (4th role) | Already carries the Android safe-area fix (`html.android-mobile` + JS-managed `--safe-top`) and the per-tab refresh fix. |

Backend work in the same window (blood-report PDF generation, referral/Whoop services, operator
endpoints, membership lifecycle) deploys via Render and reaches web + app with no rebuild.

`public/sw.js` cache `v64→v66` — mirrored, but inert in the app (service-worker registration is
stubbed out by `bb-app-config.js`).

---

## 2026-06-24 — synced to mobile repo (Weekly Report mobile redesign + Catch-up Plan reframe, v1.3.7, versionCode 18)

Ran `npm run build:www` + `npx cap sync android` in `../bodybank-app/` (mirror `public/` → `www/`);
bumped Android `versionCode 17→18`, `versionName 1.3.6→1.3.7`. Signed AAB built (versionCode 18,
~46 MB) at `android/app/build/outputs/bundle/release/app-release.aab` — ready to upload to Play
closed testing. (versionCode 17 was already used on Play, hence 18.)

| Web change | What it is | Notes |
| ---------- | ---------- | ----- |
| _(uncommitted)_ | feat(weekly report): mobile-faithful redesign of "Last Week Performance" | `public/index.html`: ≤560px layout rebuilt — calendar button, hero (ring + recap + chart) w/ green trend arrow + glow, status-icon divider row, compact metric cards (chart beside %/badge), 4-tile footer; premium polish (glows, gradient bars, chart value bubble) also lifts desktop. |
| _(uncommitted)_ | feat(catch-up): reframe step-debt to reduce panic | `public/index.html`: "Catch-up from last week" → "Steps debt"; removed "Aim for this week" total; debt now spread over ~4 weeks (gentle +extra/day) instead of one week. Client-side only. |

> ⚠️ These web changes are **not yet committed/pushed** in the web repo — only mirrored into the AAB's `www/`. Commit + push `public/index.html` so Render serves them to web/PWA testers too (and for record).

---

## 2026-06-17 — synced to mobile repo (membership/trial onboarding, v1.3.5, versionCode 16)

Ran `node scripts/build-www.js` in `../bodybank-app/` (mirror `public/` → `www/`); bumped Android
`versionCode 14→16`, `versionName 1.3.4→1.3.5`. **Committed + pushed on branch
`feat/membership-trial-onboarding` in BOTH repos. Signed AAB built (versionCode 16, ~46 MB) at
`android/app/build/outputs/bundle/release/app-release.aab` — ready to upload to Play closed testing.**
Remaining manual steps: set `TRIAL_DAYS=7` and `TRIAL_DAYS_APP=30` on Render (web = 7-day trial,
app = 30-day trial for closed testing), merge web PR (→ Render deploy), upload AAB (or merge mobile
PR → Codemagic). Create PRs via the GitHub compare links (gh CLI not installed).

> Per-client trial length: sign-up requests now send `client:'app'|'web'`; the server picks
> `TRIAL_DAYS_APP` for the app and `TRIAL_DAYS` for the web. vc15→16 because the bundle changed.

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
