# Performance Report (2 weeks) and Transformation Report (monthly)

Internally these are the "Signature" template (code, table and admin switch use that name).
Clients never see it: the PDFs, emails, WhatsApp texts and file names say **Performance Report**
(14 days) and **Transformation Report** (calendar month). Downloads are named
`BodyBank - Performance Report - <client name>.pdf`.

A second report template that runs next to the classic client progress reports
([REPORTS.md](REPORTS.md)) so the two can be compared. Admins switch between them
with the **Template: Signature | Classic** control at the top of the admin Reports tab.

Samples from seeded data: [`reports/performance-report-sample.pdf`](reports/performance-report-sample.pdf),
[`reports/transformation-report-sample.pdf`](reports/transformation-report-sample.pdf)
(`node scripts/signature-samples.js`, add `--variant=empty|extreme` or `--ai`).

## Admin control

- The Performance Report always covers 14 days: the admin picks the start date (default: the
  last two completed Mon–Sun weeks). It is scored against the 14 days before it, and its
  targets are for the next 14 days. The report calls the period "this fortnight".

- Workflow: **draft → review → approve → send**. `send` refuses anything not approved.
- No scheduler. "Draft all active clients" builds drafts only; it never sends.
- Nothing appears in the member app. A member sees a report only through the email or
  WhatsApp link an admin sends (`/r/sig/:token`), and that link resolves only for
  reports with status `sent`.
- Editing an approved report sends it back to draft (it must be approved again).
- The review screen shows staff-only notes that are never printed: big score drops,
  too little data, flagged blood markers, renewal within 21 days, and the client's own
  Sunday check-in question.

## What is in the reports

| | Performance Report: 14 days, admin picks the start date (3 pages) | Transformation Report: monthly (6 pages) |
|---|---|---|
| Cover | Score ring, headline, promise check, six pillars, 7-day habit matrix | Month, chapter title, score, highlights, day N with BodyBank |
| Data | Patterns (last 4 weeks), training, fuel, recovery, body and mind | Since day one (weight, waist, lifts, lifetime totals, photos), week-by-week score, calendar, detail charts, patterns, coaching touchpoints |
| Plan | One big lever, 3 targets with points, projection, wins, coach letter | Lever, targets, projection, week blueprint, coach letter |

The score is the same BodyBank Score as the classic report (`reportScore.scoreDataset`
on the same bundle), so the two templates always agree.

- **Targets** are structured (`metric` + `value`). Each one carries the score points it
  is worth, derived from the linear parts of the pillar formulas. The next report scores
  them automatically ("Promise check").
- **Patterns** compare the member's own days: sleep and training, weekend drift, stress
  and logging, wearable recovery, sleep and mood, rest-day steps, best weekday. Each needs
  a minimum sample, and the report states they show association, not cause.
- **Narrative**: rules first, then one LLM call (`ANTHROPIC_MODEL_REPORTS`) for the
  headline, the letter and the monthly chapter title. Every field is checked: length, no
  medical language, and every number must exist in the facts. Cost is logged under
  `admin_reports`, ref `signature_report`.

## Code

| File | Role |
|---|---|
| `services/signatureReports/model.js` | Pure view model: targets, promise check, patterns, journey, week scores, review flags |
| `services/signatureReports/narrative.js` | Rules and validated LLM narrative, coach edits |
| `services/signatureReports/data.js` | Read-only SQL for the extras: mind, wearables, lifts, lifetime totals, touchpoints, Sunday answers |
| `services/signatureReports/template.js` + `templates/signature-report.css` | A4 HTML, inline SVG charts |
| `services/signatureReports/render.js` | Uses the classic Chrome engine (`reportPdf.js`) and its fit pass |
| `services/signatureReports/service.js` | Table `signature_reports`, workflow, send, bulk drafting |
| `routes/signatureReports.js` | `/api/admin/signature-reports` (requireAdmin) and `/r/sig` |
| `public/js/admin-signature-reports.js` + `public/css/admin-signature-reports.css` | Admin screen; wraps `loadAdminReports` and does not modify the classic screen |

PDFs are stored in `UPLOADS_DIR/signature-reports/`, which returns 404 ahead of `/uploads`.
Each row keeps the full model snapshot, so a lost PDF is rebuilt identically.

Tests: `node tests/signature-report.js` (model, narrative, workflow gates, layout of
every variant). It is part of `npm run test:units` and `npm run test:reports`.

## Removing one template later

- **Signature**: delete the files above, the two `app.use` lines and the `ensureTables`
  line in `server.js`, and the two includes in `public/index.html`. Then drop the table
  `signature_reports`.
- **Classic**: Signature reuses only `reportData.js`, `reportScore.js`, `reportPdf.js`,
  `reportTemplate.assets()` (fonts and logo), `reportService.validatePeriod/periodLabel/deriveAchievements`
  and `reportInsights.numbersGrounded/MEDICAL_RE/parseJsonLoose`. Keep those when removing the
  classic screen, template and scheduler.
