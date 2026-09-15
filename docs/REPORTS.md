# Client progress reports (admin "Reports" tab)

Weekly and monthly client progress reports: a deterministic **BodyBank Score**, rule-based
insights with a validated LLM narrative, server-rendered charts, and an A4 PDF that the admin
previews, edits, generates and sends by email + WhatsApp.

Samples generated from seeded data: [`reports/sample-weekly-report.pdf`](reports/sample-weekly-report.pdf)
and [`reports/sample-monthly-report.pdf`](reports/sample-monthly-report.pdf)
(`node scripts/report-samples.js`, add `--ai` to use the LLM narrative).

## How the score works

`services/reportScore.js` scores a period out of 100. The same function scores the previous
period of equal length, which gives every pillar a trend and a delta. It is a pure function of the
data: same data, same score (`tests/report-score.js` pins a perfect, an empty and a partial week).

### Weights

| Pillar | Weight |
|---|---|
| Workout | 25 |
| Nutrition | 25 |
| Check-in | 15 |
| Consistency | 15 |
| Yoga | 10 |
| Health | 10 |

**Weekly reports with no new blood or body data** in the week move health's 10 points to workout
and nutrition (+5 each → 30/30). The same move happens in any report where health cannot be scored
at all (no two comparable weigh-ins and no marker tested twice), so a missing lab test never costs
a client ten points.

**Grades** (on the rounded score): 90+ A+ · 80 A · 70 B · 60 C · 50 D · below 50 E.

**Trend**: `deltaPct` is the change in pillar score, in points, against the previous period.
`up` at +2 or more, `down` at −2 or less, otherwise `flat`. If the previous period has no data at
all (a new client), delta is `null` and trend is `flat`.

### Pillar formulas

Rates are "days that met the rule ÷ days in the period" unless stated. A day with no log is a miss.

- **Workout** = 60% completion + 25% volume trend + 15% effort
  - completion = completed sessions ÷ planned (capped at 1). Planned = weekly target × days ÷ 7;
    the weekly target comes from `user_goals.weekly_workout_target`, else
    `users.primary_training_days_per_week`, else `tribe_members.activity_per_week`, else 3.
  - volume trend = total volume vs the previous period, capped at ±20%: +20% → full marks,
    flat → half, −20% → zero. No baseline (or no weights logged) → half.
  - effort = average RPE inside 7–9 → full; loses a third per point outside the band; no RPE → half.
  - No completed session → the whole pillar is 0.
- **Nutrition** = 50% meal logging + 30% calorie hit-rate + 20% protein hit-rate
  - logging = meals logged (max 3 counted per day) ÷ (3 × days).
  - calorie hit = day within ±10% of the calorie target.
  - protein hit = day at ≥ 90% of the protein target.
  - No calorie target → that 30% is scored on logging instead (the insight asks for a target).
    No protein target → 1.6 g per kg of latest body weight; if no weight either, scored on logging.
- **Check-in** = 50% check-in completion + 20% sleep ≥ 7 h + 15% steps target + 15% water target
  - steps and water targets come from `users.goal_steps` / `users.goal_water_ml` (defaults 8,000 / 3 L).
  - wearable rows fill sleep and steps on days the member did not log, but never count as a check-in.
- **Consistency** = 50% active days + 30% longest streak + 20% perfect days (each ÷ period days)
  - active = a check-in, a logged meal, a completed workout or a yoga session.
  - a streak-freeze day does not count as active but does not break the streak.
  - perfect = checked in + all 3 meals logged + the planned workout done (if one was planned that day).
- **Yoga** = 70% sessions ÷ planned (3 per week default) + 30% mobility trend
  - mobility trend uses the same ±20% mapping as volume; no mobility score → half.
- **Health** = 50% body-composition progress + 50% blood markers
  - body: weight change from the last weigh-in before the period to the last one in it, against
    the goal direction. Fat loss expects up to 0.5 kg/week (capped at the distance to goal), gain
    0.25 kg/week, maintain stays within max(0.5 kg, 0.25 kg/week). Waist, when measured twice, is
    averaged in.
  - blood: markers with ≥ 2 readings across all reports up to the period end; a marker is good if
    its latest value is in range **or** moved toward range. Score = good ÷ eligible.
  - Only one half available → that half is the whole pillar.

## Where the data comes from

`services/reportData.js` maps each source to the real schema (read-only):

| Report source | Tables |
|---|---|
| Workouts, sets/reps/weight | `workout_logs` (`session_date`, `session_lifts`, `session_reps`), `wearable_workouts` on days with no manual log |
| RPE | `workout_logs.intensity` (Easy 5 · Moderate 7 · Hard 8.5 · Max Effort 10); no numeric RPE is stored |
| Meals, macros, targets | `nutrition_meal_logs.ai_result`; `nutrition_assessments.derived.calorie_target`; `users.goal_protein_g` |
| Check-ins | `daily_checkins` (sleep, steps, water, freeze) + `readiness_daily` via `getReadinessRange` |
| Energy / recovery | `workout_logs.energy_level` (Low/Medium/High); wearable recovery when present. There is no mood or stress column. |
| Yoga | `workout_logs` rows whose name is a yoga practice (AI Trainer postures, Surya Namaskar) + wearable yoga. **No mobility score is stored anywhere yet**, so the mobility chart shows its empty state until one is. |
| Body, photos | `body_snapshots` (weight, waist, measurements, photos shared with the coach), `progress_logs.weight`, `smart_scale_uploads` |
| Blood | `blood_analysis_reports.extracted_blood_data` (parsed with the comparison engine's helpers) and the stored `ai_report` summary |
| Achievements | derived: personal bests, streaks, perfect days, targets met, `coin_ledger`, the client's own Sunday check-in answer |
| Goals | `user_goals`, `users.goal_type`, `tribe_members.target_weight` |

## Insights and narrative

`services/reportInsights.js`:

1. **Rules first**: one Insight and one Action per pillar (e.g. weekend protein gap → "Add one 30 g
   protein shake on weekend mornings"), Top 3 improvements / Top 3 to improve, and the blood
   behaviour-link paragraph.
2. **One LLM call** (`ANTHROPIC_MODEL_REPORTS`, else `ANTHROPIC_MODEL`) writes the 3-line cover
   summary, the closing coach note, 3 measurable targets and the blood paragraph, in the WhatsApp
   coach's voice (`services/waKlingPrompt.js` style guide). Cost is recorded in the token ledger
   under `admin_reports`.
3. **Every field is validated**: exact shape, length limits, no number that is not in the facts,
   targets must contain a number, and no diagnosis/treatment language. A field that fails is
   replaced by its rule-based version; if the call fails entirely the whole narrative is rule-based.
   A report is never blocked.

The blood section is informational only. Every out-of-range marker carries **"Discuss with your
doctor"**, and that sentence is re-attached if the model drops it.

## PDF

`templates/report.html` + `templates/report.css`, printed by Puppeteer (headless Chrome) to A4
with backgrounds. Charts are drawn with Chart.js inside the same Chrome and embedded as PNG at 3×.

Page order: Cover/Scorecard → Workout → Nutrition → Check-in & Consistency → Yoga & Recovery →
Body & Progress → Blood Reports → Achievements & Next Plan. Weekly reports merge Yoga into the
check-in page and include Body/Blood only when the week has new data; monthly reports always
have all eight pages.

Layout guarantees (enforced by `tests/report-render.js` on empty, normal and extreme data):
one page per section, no blank pages, no text off the page or overlapping, header and footer on
every page, no page body overflow. Two passes make it fit: a probe measures each page's free space
and grows the charts to fill it; a fit pass shrinks any over-long single line and steps chart
heights down if a page would ever overflow.

## API (admin only)

| Method | Path | |
|---|---|---|
| POST | `/api/admin/reports/preview` | HTML (`?format=json` also returns the editable draft) |
| POST | `/api/admin/reports/generate` | PDF + `reports` row, fires `REPORT_GENERATED` |
| POST | `/api/admin/reports/:id/send` | email (PDF attached) and/or WhatsApp link, fires `REPORT_SENT` |
| GET | `/api/admin/reports?userId=` | history |
| GET | `/api/admin/reports/:id/pdf` | download (`?inline=1` to view) |
| POST | `/api/admin/reports/bulk` | all active clients → `jobId`; `GET /bulk/:jobId` for progress |
| GET | `/api/admin/reports/clients?q=` | client picker |
| PUT | `/api/admin/reports/clients/:userId/auto` | per-client `auto_reports` flag |
| GET | `/r/report/:token` | the client's expiring link (public, token is the credential) |

## Operations

- **Table** `reports` (+ `users.auto_reports`) is created at boot by the report service.
- **Storage**: PDFs are written to `UPLOADS_DIR/client-reports/` (404'd ahead of the public
  `/uploads` mount). If a redeploy wipes the file, it is rebuilt on demand from the stored score
  and narrative.
- **Scheduler**: Monday 06:00 IST (previous Mon–Sun) and the 1st at 06:00 IST (previous month),
  only for clients with `auto_reports` on, generate + send. Off switch: `REPORTS_SCHEDULER_ENABLED=false`.
- **WhatsApp**: sent with the Twilio fallback sender. Outside the 24-hour window Twilio needs an
  approved template: set `TWILIO_CLIENT_REPORT_TEMPLATE_SID`. The sent message is recorded in the
  client's Grok agent thread (`wa_messages`), so a reply is answered in context.
- **Env**: `REPORT_SHARE_LINK_DAYS` (30), `REPORTS_COACH_NAME` (Kling), `ANTHROPIC_MODEL_REPORTS`,
  `PUBLIC_URL` (link base), `PUPPETEER_EXECUTABLE_PATH` (optional local Chrome).
- **Chrome on Render**: `npm ci` downloads the headless shell into `./.cache/puppeteer`
  (`.puppeteerrc.cjs`), which ships with the build. No extra build step.
- **Tests**: `node tests/report-score.js`, `node tests/report-insights.js`, `node tests/report-render.js`.
