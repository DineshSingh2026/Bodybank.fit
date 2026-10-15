# BodyBank Challenges

Members join a fixed run of days (Starter 7, Reset 15, Transformation 30) with a few small tasks a day. They earn coins, a badge, a certificate, an upgrade discount (web checkout only) and a lifestyle manager call.

**Members never tick a task by hand.** The server reads what they already do elsewhere in the app and ticks the task for them: daily check-ins, meal logs, Coach Mode and My Workout sessions, mind check-ins and Sunday check-ins.

My Workout, Coach Mode, the bottom navigation and the existing payment flows are unchanged. All schema changes are new tables.

## Files

| Piece | Where |
|---|---|
| Rules, flag, time zones, schema (pure) | `services/challengeService.js` |
| DB engine: sync, joins, rewards, leaderboard, reminders, discounts | `services/challengeEngine.js` |
| Seed (drafts) | `data/challenges/*.json`, `services/challengeSeed.js`, `npm run seed:challenges` |
| Same SQL as a migration | `scripts/migrations/20261015_challenges.sql` |
| API | `routes/challenges.js`, mounted at `/api/challenges`; share page `/c/:token` |
| Certificate PDF | `services/challengeCertificate.js` (pdfLayout kernel; covered by `tests/pdf-layout-audit.js`) |
| Share card PNG | `services/challengeShareCard.js` (SVG → PNG with `sharp`) |
| Member UI | `public/js/challenges.js`, `public/css/challenges.css` (lazy) |
| Loader, home card, sidebar link, marketing banner | `public/js/challenges-loader.js` |
| Admin screen | `public/js/challenges-admin.js`, `public/css/challenges-admin.css` (Programs → Challenges) |
| Landing page | `pages/challenge/index.html`, served at `/challenge` (not bundled into the apps) |
| Tests | `tests/challenges-unit.js` (in `test:units`), `npm run test:challenges-api` (needs the DB), `npm run test:challenges-e2e` (needs a running server) |

### Hooks in existing files

All hooks are small and additive:

- **`server.js`**:
  - requires and the boot DDL;
  - a draft seed import, which runs only when the `challenges` table is empty;
  - the engine;
  - a debounced activity hook after `POST/PUT` to check-in, workout, meal, mind, Sunday and Coach Mode routes;
  - the router mount, `/c/:token`, `/challenge` and `/sitemap.xml`;
  - a cron job every 30 minutes;
  - a `discounts` option passed to `createPaymentsService`.
- **`public/index.html`**:
  - the loader script tag;
  - the sidebar link;
  - `#usec-challenge`;
  - one line each in `switchUserTab` and `switchTab`;
  - the admin tab container and its Programs card.
- **`public/js/coach-loader.js`**: an optional `bbCoachOpen({ area })` argument. Called without it, nothing changes.
- **`services/payments.js`**:
  - `createOrder` looks up a challenge discount, and only when a `discounts` option is passed;
  - `fulfil` marks the discount used after commit.
- **`routes/payments.js`** returns `discount` in the order response.
- **`public/pricing.html`** shows the discount in the Razorpay description.

## Feature flag

`CHALLENGES_ENABLED` takes `off` (the default), `staff`, `allowlist` or `all`. `CHALLENGES_ALLOWLIST` holds comma-separated user ids or emails.

| Mode | Member API + UI | Public: `/challenge`, `/api/challenges/public`, `/c/:token`, share images, marketing banner |
|---|---|---|
| `off` | 404 / hidden | `/challenge` and `/c/…` redirect to `/`; the API answers 404 |
| `staff` | staff only (members see nothing) | off |
| `allowlist` | staff plus the allowlist | off |
| `all` | every member | on |

The admin screen works in every mode, so challenges can be built and reviewed before rollout.

**Rollout:** `off` → `staff` → `allowlist` (Kling and 5 in-house clients) → `all`. Turn on `all` only after Kling has published `starter-7`.

**Rollback:**
1. Set `CHALLENGES_ENABLED=off`: routes 404, the UI hides, the cron skips, and `/challenge` sends visitors to `/`. The tables stay.
2. Discounts stop being applied while the flag is off. Codes already issued come back if the flag returns, until they expire.

## Publishing (the approval step)

1. Seeds always land as **drafts**. A fresh database imports the three seed files as drafts at boot.
2. Admin → Programs → **Challenges**:
   - check the details, rewards, day headlines and the tasks for every day;
   - press **Publish**.
3. Publish refuses a challenge that is missing tasks on any day, or that has prices, blood data or medical claims in its text.
4. Once anyone has joined:
   - the length is locked;
   - task kinds and targets are locked. Only titles, points and day headlines can change, so nobody's progress shifts mid-run.

For local testing, `node scripts/challenges-seed.js --publish starter-7` publishes a challenge from the command line.

## How a task counts (evidence rule)

A row counts for challenge day **D**, in the time zone frozen at join (`users.timezone`, else `Asia/Kolkata`), only when all of these hold:

- its business date is D: `checkin_date`, `log_date`, `local_date` or `session_date`;
- it was **created during day D** in that time zone;
- for value tasks (steps, water, protein from the check-in, sleep), it was **not edited after day D ended**;
- it is not a streak-freeze row;
- for workouts: My Workout rows under 5 minutes are ignored, and Coach Mode needs at least 3 sets.

Nothing is back-filled, and nothing counts for a future day.

**Time zones.** Naive `timestamp` columns are read in the database session's `TimeZone`: UTC on Render, often `Asia/Kolkata` on a dev machine. `localDayOf()` is the single helper for this; it is unit-tested across Toronto, Kolkata and the DST boundaries.

**Protein** uses the larger of the check-in figure and the sum of that day's valid meal logs, against `users.goal_protein_g` (default 120 g) × the task's percentage (default 90%). This matches the two-week report.

## Completion, coins and rewards

**Finishing:**
- Starter: 6 of 7 full days (one grace day).
- 15 and 30 days: 85% of days (13 and 26).
- A run fails early once finishing is impossible. The member can start again.
- The free Starter can be taken once per 90 days.

**Coins:**

| When | Coins | Key |
|---|---|---|
| Every fully done day | 10 | `coins:challenge:<enrollment>:day:<n>` |
| Finishing | 100 / 250 / 600 | `coins:challenge:<enrollment>:complete` |

Both keys are paid once, even under retries.

**On finishing:**
- a badge;
- a certificate PDF with a signed 10-minute link, opened in the app's PDF viewer;
- a 15% discount (`CHALLENGE_UPGRADE_DISCOUNT_PCT`), valid 14 days on Guided or Tribe Elite;
- an LM call offer.

Every reward is keyed in `challenge_rewards.reward_key`.

**Leaderboard:**
- members only: staff, operators and BloodMap shadow accounts are excluded;
- accounts younger than 24 hours are hidden;
- members can opt out at join and on the board;
- names show as first name plus last initial;
- ties go to whoever finished first.

## Store policy

The apps bundle `public/`, so the member UI has **no prices and no purchase links** (`tests/challenges-unit.js` greps the bundles).

The discount shows as a fact: "Upgrade discount unlocked · 15%". On Android and web it adds "use it on bodybank.fit" as plain text, never a link. On iOS that text is left out.

The discount is applied **server side on the web checkout only**:
1. `createOrder` prices the order.
2. It stores `discount_id` in the Razorpay notes and maps the order to the discount.
3. A fulfilled payment marks the discount used. This is idempotent: the first paid order wins.

The browser never sends an amount or a percent.

## Webhooks and notifications

`notifyAgent` sends each of these once, in the same payload style as `WORKOUT_LOGGED`:

- `CHALLENGE_JOINED`
- `CHALLENGE_DAY_DONE`
- `CHALLENGE_COMPLETED`
- `CHALLENGE_LM_CALL_REQUESTED`

**Member pushes** come from the 30-minute cron:
- a morning reminder at the member's usual check-in hour, only while nothing is done yet;
- an evening "N tasks left" at 19:00 local;
- never between 22:00 and 07:00;
- at most 2 a day (`challenge_push_log`);
- a "challenge complete" push on finishing.

All of them deep-link to `/?open=challenge`.

**Staff** get a push when a finisher requests the LM call. The queue is under Admin → Challenges → Call requests.

## Landing page `/challenge`

The page is standalone:
- inline CSS and about 5 KB of JS, with no Chart.js;
- async Google Fonts;
- an OG image from `/api/challenges/og.png`;
- JSON-LD for Organization, Course and FAQPage;
- a listing in `/sitemap.xml` while the page is public.

**Start free today:**
- A signed-in member joins straight away.
- A visitor goes to `/signup?next=/challenge?join=1`, then auto-joins and lands on `/?open=challenge`.
- `utm_*` and `?ref=` are kept in sessionStorage and sent with the join. The referral code is also handed to the existing signup modal.
- Signed-in members get an "Invite a friend" link: `/challenge?ref=<their code>`.

The marketing home gets a hero pill and a section, but only for web visitors and only while the public flag is on.

The mockup's "From a finisher" quote was left out on purpose: it was example data. Add a real, consented quote when one exists.

## Native apps

The UI ships with the next store release (`npm run build:www` in `bodybank-mobile-app`, then the usual separate Android and iOS steps). Older builds never call `/api/challenges`, so the API stays backward compatible.

- **Share.** Uses `@capacitor/share` when present. On the web it uses Web Share with the PNG, or downloads the PNG.
- **Android back button.** Uses the same scoped `@capacitor/app` listener as Coach Mode.
- **Universal links / App Links for `https://www.bodybank.fit/challenge` are NOT configured** (there is no `apple-app-site-association` or `assetlinks.json` today). To add them:
  1. serve `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` explicitly (Express skips dotfiles; see the Apple domain-verification route);
  2. add the Associated Domains entitlement on iOS and an `autoVerify` intent filter on Android;
  3. route `/challenge` to `/?open=challenge` inside the app.

  Until then, the link opens the website.

## Known limits and follow-ups

- **TODO: Coach Mode back-dated coins (not changed here).** `routes/coachMode.js` (around line 300) and `coachModeService.LIMITS.pastDays = 30` let a Coach Mode save carry a `local_date` up to 30 days back, and coins are paid on that day. Challenges do not trust that date (see the evidence rule), but the Coach Mode coin day should be clamped to the creation day in a separate PR.
- `bbCoachOpen({ area })` preselects the body area only the first time Coach Mode loads in a session, because `coach-mode.js` keeps its own area once open. The member can still tap the area.
- **Paid challenges.** "Core pays a one-time price for Reset 15" is not built. Members outside the included tiers see "your lifestyle manager can unlock it", and staff use **Enrol a member** in the admin screen. A web purchase flow would be a separate phase.
- `sharp` is a devDependency. Without it, share cards are served as SVG, which WhatsApp and Instagram previews don't render. Move `sharp` to `dependencies` if production installs with `--production`.
- The test stack is puppeteer (already installed), not Playwright, and there is no Lighthouse CI. `tests/challenges-e2e.js` covers 390, 412 and 1366 px: landing → join → day view → tick, back navigation, the offline join queue and basic a11y.
- The certificate signature is text ("Coach Kling, Founder, BodyBank"). Swap in an image when Kling provides one.

## Product decisions used (defaults from the brief)

| Decision | Used |
|---|---|
| Certificate signature | Coach Kling, Founder, BodyBank (text) |
| Upgrade discount | 15% off the first payment for Guided or Tribe Elite, 14 days, one use |
| 15 Day Reset | Included in Guided and Tribe Elite; others via staff enrol |
| 30 Day Transformation | Included in Tribe Elite; others via staff enrol |
| Missed days | Starter 6 of 7; longer runs 85% |
| Coins | 10 a day, plus 100 / 250 / 600 on finishing |
| Leaderboard | On by default, opt out any time, first name and last initial |
| LM call | Offered to Starter and Transformation finishers; within 72 hours |
| Share card | No body data; protein days only if the member ticks "include my results" |
| Repeat Starter | Once per 90 days |
