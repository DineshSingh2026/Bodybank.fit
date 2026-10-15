# Coach Mode

Guided gym logger for members, inside the **Train** tab. My Workout, the bottom navigation and the landing page are unchanged.

**Flow:** pick a body area → pick exercises → form guide → log sets (kg/reps steppers, "last time", rest timer) → next exercise → summary → save.

## Files

| Piece | Where |
|---|---|
| Schema (boot DDL) | `services/coachModeService.js` `DDL`, run from `initDB()` |
| Same SQL as a migration | `scripts/migrations/20261015_coach_mode.sql` |
| API | `routes/coachMode.js`, mounted at `/api/coach` in `server.js` |
| Member UI | `public/js/coach-mode.js`, `public/css/coach-mode.css` (lazy loaded) |
| Loader, Train card, sidebar link | `public/js/coach-loader.js` |
| Admin review screen | `public/js/coach-admin.js`, `public/css/coach-admin.css` (Training → Coach Mode library) |
| Curated library | `data/coach/whitelist.json`, `data/coach/drafts/<id>.json` (185 drafts) |
| Photos | `public/img/coach/<id>-<n>-<480\|960>.webp` (about 14 MB) |
| Seed | `npm run seed:coach` (`scripts/coach-seed.js`) |
| Tests | `tests/coach-mode-unit.js` (runs in `test:units`), `npm run test:coach-api` (needs the DB) |

All schema changes are additive:
- three new tables: `coach_exercises`, `coach_workouts`, `coach_sets`;
- `coach_exercises.per_side` and `coach_exercises.ai_trainer_key`;
- `users.coach_care_tags`.

## Feature flag

`COACH_MODE_ENABLED` takes one of four values:

- `off`: every member route returns 404, and the Train card and sidebar link stay hidden.
- `staff`: admin, superadmin and operator only.
- `allowlist`: staff plus `COACH_MODE_ALLOWLIST`, a comma-separated list of user ids or emails.
- `all` (the default since launch, 2026-10-15): every member.

Rollout order: staff → Kling's test accounts → 5 in-house clients → everyone.

To roll back, set the flag to `off`. The tables are harmless to keep. Mirror rows in `workout_logs` have `workout_type = 'coach_mode'`.

## Going live (production)

Launched 2026-10-15. The owner approved the whole launch library.

1. Deploy. The boot DDL creates the tables.
2. On the first boot with an empty `coach_exercises` table, the server imports `data/coach/library.json` (185 exercises, **approved**, `reviewed_by = 'launch-import'`). A non-empty table is never touched.
   - To rebuild that file after editing drafts: `node scripts/coach-seed.js --export`.
   - To add new exercises to an existing library as drafts: `npm run seed:coach`.
3. Coaches can edit any exercise later in **Training → Coach Mode library**. Approving needs every checklist box ticked and a review note.
4. Set care tags for members who need them, in the "Member care tags" tab:
   - `recovery` and `pregnancy` hide every exercise with that tag;
   - `kidney_gentle`, `knee`, `lower_back` and `shoulder` add a soft "go lighter" note.

## Behaviour notes

**Saves are idempotent.**
- The phone creates `client_uuid` when the workout starts, and `UNIQUE(user_id, client_uuid)` dedupes retries.
- A retry returns `{duplicate:true}`. It never creates a second workout, sets, mirror row or coin payout.

**Offline.**
- A network failure, 5xx or 429 puts the workout in `localStorage.bb_coach_outbox_v1`.
- It syncs on `online`, app resume, Coach Mode open, or by backoff.
- A 4xx keeps the workout and shows the error.

**Workout in progress.** It lives in `localStorage.bb_coach_draft_v1`, so an app kill or reload resumes at the same set.

**Coins.**
- A save pays `workout_session` with the same event key as My Workout, so a day pays once whichever screen logs first.
- The payout is dated to the workout's local day, never a future day.
- TODO (known issue): `local_date` may be up to 30 days in the past (`LIMITS.pastDays`), so a late sync still pays coins on that old day. Clamp the coin day to the day the workout was created. Challenges already ignore back-dated rows; see `docs/CHALLENGES.md`.
- Coach Mode never writes `daily_checkins` (the streak) or touches the AI Trainer trial counters.

**AI form check.**
- The button shows only when an exercise has `ai_form_check` on, an `ai_trainer_key` set, and the member's plan includes `ai_trainer`.
- It links to `/ai-trainer.html?exercise=<key>&from=coach`. `ai-trainer.html` was not modified, so it opens on its own default exercise; preselecting the move would need a change there.

**Library gaps.** These moves are not in free-exercise-db, so they would need custom entries:
- burpees and jumping jacks (the only route to the AI Trainer's `jumpingjack` key);
- bird dog and hollow hold;
- bodyweight calf raise and wall sit.

Core (33) and full body (17) are below the 60–80 target for the same reason.

## Native apps

The apps bundle `public/` into `www/`, so the UI ships only with a store release.

To build, in `bodybank-mobile-app`:
1. `npm i @capacitor/app`. It enables the back-button handling in `coach-mode.js`; without it, Android back still walks the web history.
2. `npm run build:www`.
3. Then the usual Android and iOS release steps. See the release-separation notes: Android and iOS ship separately.

The API stays backward compatible: older app builds never call `/api/coach`.
