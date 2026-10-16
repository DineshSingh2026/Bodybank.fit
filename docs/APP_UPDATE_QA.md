# App update alert: how it works and manual QA

Tells Android and iOS app users when a newer store build exists, and blocks builds
below a minimum until they update. Free pieces only: `@capacitor/app` (already
installed) and `@capawesome/capacitor-app-update` 7.2.0 (MIT).

## Pieces

| Where | File | What |
|---|---|---|
| Web repo | `services/appVersionService.js` | Pure helpers: `parseSemver`, `compareSemver`, `configFromEnv`, `resolveConfig`, `evaluate`, `validateUpdate` |
| Web repo | `routes/appVersion.js` | `GET /api/app/version` (public), `GET/PUT /api/admin/app-version[/:platform]`, `POST /api/admin/app-version/:platform/notify` |
| Web repo | `server.js` | Boot DDL for `app_release_config`, the two mounts, `sendFcmToUser(..., { platform })` |
| Web repo | `public/js/admin-app-version.js` | Admin screen: Analytics, then App Version |
| Web repo | `public/js/bb-notify.js` | Tapping an `app_update` push opens the store |
| Mobile repo | `src-web/bb-app-update.js` | The check, soft card, force screen, Play In-App Updates |
| Mobile repo | `scripts/build-www.js` | Copies and injects `bb-app-update.js` right after `bb-app-config.js` on every page |

## Rules

* **Server decides**, Play only supplies the mechanism. Force means installed < `min_supported_version`,
  or `force` is on and installed < `latest_version`. Soft means installed < `latest_version`.
* **Fail open.** Network error, 5 second timeout, non 200, bad JSON, `enabled:false`, or an
  unparseable version shows nothing. The last good response is cached 24 h
  (`bb_app_version_cache`) and used offline for the soft card only, never to newly block.
  A force screen already up stays when the device goes offline, with an offline note.
* **Soft card**: dismissible. `Later` stores `bb_update_dismissed = { version, at }`; it comes back
  after 3 days for the same latest, at once for a newer latest. Held back on sign in / sign up pages,
  while a modal is open, while Coach Mode is on screen, and while the PWA update modal shows.
* **Force screen**: full screen, z-index 100600 (above `#bb-update-modal` at 100500), Android
  back button does nothing while it shows.
* **Checks**: on launch and on resume, at most once per 30 minutes; a force screen re-checks on every
  resume (so lowering the minimum releases users).
* **Precedence**: a field saved in the admin screen (`app_release_config`) wins over env. An empty table
  means env values.
* **Push**: "Notify app users" sends one FCM push to that platform's devices only (no web push, no bell
  row), once per platform + version. `device_push_tokens` does not store the app version, so users already
  on the latest build also get it; tapping just opens the store page.

## Env (Render)

| Variable | Default |
|---|---|
| `APP_UPDATE_ALERT_ENABLED` | `all` (`off` hides everything, `staff` = admin, superadmin, operator only) |
| `APP_IOS_LATEST_VERSION` / `APP_IOS_MIN_VERSION` / `APP_IOS_FORCE` / `APP_IOS_STORE_ID` | `1.0.10` / `1.0.6` / `false` / `6808102656` |
| `APP_ANDROID_LATEST_VERSION` / `APP_ANDROID_MIN_VERSION` / `APP_ANDROID_FORCE` / `APP_ANDROID_PACKAGE` | `1.8.7` / `1.8.2` / `false` / `com.bodybank.app` |
| `APP_UPDATE_NOTES_IOS` / `APP_UPDATE_NOTES_ANDROID` | empty |

**Important:** only builds that contain `bb-app-update.js` can show the alert. Builds already in the
stores (Android 1.8.8 and below, iOS 1.0.11 and below) never will. Raise `min_supported_version` only
after the first build with this feature is live, and only to versions that include it.

## Automated tests

* Web: `node tests/app-version-unit.js` (in `npm run test:units`), `npm run test:app-version-api` (needs `DATABASE_URL`),
  `node tests/html-scripts-parse.js`.
* Mobile: `npm run test:app-update` (fake clock, fake localStorage, fake Capacitor plugins).

## Manual QA checklist

1. **Endpoint.** `GET /api/app/version` returns the JSON above with `Cache-Control: public, max-age=300`.
   `?platform=ios&version=1.0.8` adds `"evaluation": { "status": "soft" }`. With `APP_UPDATE_ALERT_ENABLED=off`
   it returns `{ "enabled": false }` and no UI shows anywhere.
2. **iOS soft.** Build 1.0.10 with latest 1.0.10: nothing. Set latest 1.0.11: soft card. `Later` hides it.
   Move the device clock forward 3 days: it returns. Set latest 1.0.12: it shows at once.
3. **iOS force.** Set iOS minimum 1.0.11: force screen on launch and on resume. `Update now` opens the
   App Store page for id6808102656.
4. **Android.** Repeat 2 and 3 with 1.8.7 / 1.8.8. On the Play internal track test the flexible flow
   (Update, download, "Update downloaded", Restart) and the immediate flow (force). A sideloaded APK falls
   back to the Play store link. The back button does not dismiss the force screen.
5. **Fail open.** Airplane mode on launch: the app opens normally. Server returning 500: the app opens normally.
6. **Web.** Browser and installed PWA: no app update UI; the existing PWA update modal still works.
7. **Coach Mode.** During a Coach Mode session the soft card waits and appears once the session screen closes.
8. **Safe areas.** iPhone with a notch and Android gesture navigation: the card sits above the bottom nav
   and the WhatsApp button, never over them.
9. **Admin.** Analytics, then App Version: saves, validates (bad version, minimum above latest), confirm
   dialog before Force turns on, "Notify app users" sends once per version (second tap is refused).
10. **Analytics.** GA DebugView shows `app_update_check`, `app_update_prompt_shown`, `app_update_clicked`,
    `app_update_dismissed`, `app_update_check_failed`.
