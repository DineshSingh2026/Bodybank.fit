# Health Map Report — changelog and rollback

## 1.0.0 — 2026-09-10

Adds a **second blood-report variant**. The existing report is untouched: every existing row, route,
payload and shipped mobile build behaves exactly as before.

### What a coach sees

1. Uploading a blood report for a client now asks **two** questions instead of one — the lab date, and
   which of the two reports the client gets:
   - **Standard Health Report** — what BodyBank has always produced
   - **Health Map Report** — health-area grades (A–D), top-three priorities, trends
2. Every report card carries a badge showing which format it is on, and a **Switch to…** button. The
   switch is instant and free: it re-runs only the deterministic engines over the extraction already
   saved. No AI call, no cost.
3. A Health Map report gets an **Edit & preview** button, opening a two-pane editor: sections on the
   left, a live preview of the printed page on the right. Save, Reset, Download PDF and Send from there.
4. Download and Send are unchanged buttons — they now produce whichever report the client is on.

### New files

| Path | Purpose |
|---|---|
| `services/grading/markerRegistry.js` | 69 canonical markers: aliases, areas, weights, directions, units, preferred ranges, correlation groups |
| `services/grading/classify.js` | Deterministic status from value + range |
| `services/grading/rules.js` | Sufficiency, accumulation thresholds, ceilings, 16 pattern rules |
| `services/grading/copy.js` | Every client-facing sentence, from templates |
| `services/grading/index.js` | The grading engine |
| `services/comparison/index.js` | Clinical-significance thresholds and trends |
| `services/priority/index.js` | Priority selection |
| `services/gradedHealthReport.js` | Assembles the typed report model |
| `services/gradedReportDocument.js` | The editable document layer |
| `services/gradedReportPdfKit.js` | The PDF renderer |
| `services/gradedReportService.js` | Persistence and orchestration |
| `services/pdfText.js` | Shared WinAnsi transliteration |
| `public/js/graded-report-editor.js` | The editor and live preview |
| `public/css/graded-report.css` | Editor and preview styling |
| `tests/graded-report-engines.js` | 9,251 checks — registry, classifier, rules, comparison, priority, safety |
| `tests/graded-report-render.js` | 47 checks — document contract and PDF render |
| `tests/graded-report-service.js` | 90 checks — persistence, routes, isolation from the classic report |
| `fixtures/demo/*.json` | Synthetic screenings, watermarked DEMO DATA |
| `scripts/graded-report-demo.js` | Print the report as text |
| `scripts/graded-report-pdf-demo.js` | Render the demo PDF |
| `docs/health-report-redesign/METHODOLOGY.md` | Plain-language description for clinical review |

### Modified files

| Path | Change |
|---|---|
| `server.js` | Eight additive `ADD COLUMN IF NOT EXISTS` migrations plus one index, in `initDb()` |
| `routes/blood.js` | Five new staff routes; `/pdf/:id` and `/admin/send/:id` branch on variant; `mapReportRow` gains four fields; `/admin/upload/:userId` accepts `reportVariant` |
| `public/index.html` | Variant picker in the upload modal, variant badge and switch on report cards, editor launch button, styles, two asset links |
| `public/js/operator-console.js` | Passes the chosen variant on the operator upload path |
| `package.json` | Three test suites registered in `test:units`; two demo scripts |

### Schema

All additive, all defaulted, all reversible.

```sql
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS report_variant TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS graded_report JSONB;
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS graded_doc JSONB;
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS graded_doc_updated_at TIMESTAMPTZ;
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS graded_doc_updated_by TEXT DEFAULT '';
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS graded_pdf_path TEXT;
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS engine_version TEXT;
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS ruleset_version TEXT;
CREATE INDEX IF NOT EXISTS idx_blood_reports_variant ON blood_analysis_reports(report_variant);
```

`report_variant` defaults to `'classic'`, so every pre-existing report keeps producing the report it
always did.

### API

**New (all staff-gated: admin, superadmin, operator):**

- `PUT /api/blood/admin/variant/:reportId`
- `GET /api/blood/admin/report/:reportId/graded-doc`
- `PUT /api/blood/admin/report/:reportId/graded-doc`
- `POST /api/blood/admin/report/:reportId/graded-doc/reset`
- `GET /api/blood/admin/report/:reportId/graded-rationale`

**Changed, without breaking the contract:**

- `GET /api/blood/pdf/:reportId` — same auth, same shape; the row's variant decides which generator runs
- `POST /api/blood/admin/send/:reportId` — sends whichever report the client is on
- `POST /api/blood/admin/upload/:userId` — accepts an optional `reportVariant`, defaults to `classic`
- `mapReportRow` — **adds** `reportVariant`, `gradedDocEdited`, `gradedDocUpdatedAt`, `gradedDocUpdatedBy`.
  Every existing key is unchanged, so shipped Android and iOS builds ignore the new ones.

### Cost

The graded engines are pure computation over an extraction that has already been paid for.
Building, rebuilding, switching variant, editing and resetting all cost **nothing** and call no model.

---

## Rollback

### Level 1 — turn it off without deploying (seconds)

```sql
UPDATE blood_analysis_reports SET report_variant = 'classic';
```

Every report immediately serves the classic PDF. The graded columns keep their data; nothing is lost, and
setting a row back to `'graded'` restores its edited document intact.

### Level 2 — revert the code

Revert the commit. The graded columns remain on the table, unread and harmless — the classic pipeline
never touches them. `initDb()` is idempotent, so an older build starts cleanly against the newer schema.

### Level 3 — remove the schema

```sql
DROP INDEX IF EXISTS idx_blood_reports_variant;
ALTER TABLE blood_analysis_reports
  DROP COLUMN IF EXISTS report_variant,
  DROP COLUMN IF EXISTS graded_report,
  DROP COLUMN IF EXISTS graded_doc,
  DROP COLUMN IF EXISTS graded_doc_updated_at,
  DROP COLUMN IF EXISTS graded_doc_updated_by,
  DROP COLUMN IF EXISTS graded_pdf_path,
  DROP COLUMN IF EXISTS engine_version,
  DROP COLUMN IF EXISTS ruleset_version;
```

Only do this after the code is reverted. No existing column is altered by any level of rollback, and no
classic report data is touched at any point.

### Orphaned files

Graded PDFs live in `uploads/health-reports/BodyBank_HealthMap_*.pdf` — the same directory as every
other generated report, which is already 404'd ahead of the public `/uploads` static mount. They can be
deleted safely at any time; the next download regenerates from the stored document.

---

## Verification before deploy

```bash
npm run test:units          # includes the three graded suites
node scripts/graded-report-demo.js --why     # full report as text, with the grade rationale
node scripts/graded-report-pdf-demo.js       # renders the demo PDF
```

Not yet run against a live database.
