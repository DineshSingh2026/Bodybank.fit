# Phase 0 — Audit & Proposal: Graded Health Report (second report variant)

**Status:** **Superseded — Phase 1 is built.** See [CHANGELOG.md](CHANGELOG.md) for what shipped and
[METHODOLOGY.md](METHODOLOGY.md) for the clinical rule set. This memo is kept as the audit record of the
architecture decision.
**Author:** Claude (Opus 5) · **Date:** 2026-09-10 · **Repo:** `bodybank` (web + Node/Express + PostgreSQL on Render)
**Scope:** A **second, additive report variant** for the existing blood-report pipeline. The current report is untouched.

---

## Decisions taken

The eight open questions in §13 were resolved as follows, on the owner's instruction to proceed.

| # | Question | Decision |
|---|---|---|
| 1 | Naming (F5) | **Option A.** Internal `report_variant = 'graded'`; client-facing **BodyBank Health Map Report**. No third-party name appears in the product, the code or anything a client receives. |
| 2 | Clinical pass (§3.1) | **Option B.** The Opus analysis pass is kept and unchanged; the grading layer sits on top and carries the clinical narrative through as an editable section. |
| 3 | Web surface (F2) | **(i) plus the editor preview.** The client still receives a PDF, exactly as today. Staff get a two-pane editor whose live preview renders the same document the PDF renders. A member-facing HTML report stays on the backlog; the renderer it would need now exists. |
| 4 | Deterministic status (F1) | **Confirmed.** The graded variant derives status arithmetically. Where neither a lab range nor a BodyBank preferred range is available, the extracted status is shown, labelled, and excluded from grading. |
| 5 | Clinical sign-off | **Outstanding.** METHODOLOGY.md §10 lists exactly what needs a clinician's eye. This is the one item that should gate a live rollout. |
| 6 | Preferred ranges | **Permitted, always labelled.** Used only where documented in the registry, and every such row prints "BodyBank preferred range" with a footnote on the table. |
| 7 | Real reports (R5) | Built and validated against synthetic fixtures under `fixtures/demo/`. Validation against ten real historical reports is still worth doing before rollout. |
| 8 | R1 / R2 follow-ups | **Documented, not fixed.** The classic report keeps its LLM-authored status and its threshold-free comparison. Both remain backlog items BL-2 and BL-3. |

---

## 0. Executive summary

The existing blood pipeline is in better shape than expected: extraction, alignment, PDF generation and
the comparison-report editor are already well-separated services. A second report variant can be added
**without changing a single line of the current report's code path** — the new variant is a parallel
branch selected by one new column, `blood_analysis_reports.report_variant`.

Five things in the brief collide with what is actually in the repo. Each needs a decision at this gate.

| # | Finding | Impact |
|---|---------|--------|
| **F1** | **`STATUS` is LLM-generated today.** Haiku decides `Normal / Low / High / Critical` during extraction. §12.1 of the brief forbids an LLM string in the STATUS layer. | Blocks the grading engine unless we add a deterministic classifier. **Recommendation: build one; keep the extracted status as a labelled fallback.** |
| **F2** | **The health report has no web rendering at all.** It is PDF-only; the member screen is a row with a "Download PDF" button. | §13 components and §15 responsive behaviour are *net-new surface*, not a redesign. Scope decision needed. |
| **F3** | **The single report has no editable document layer.** Only the *comparison* report has `report_doc` plus a full editor. "Editing → previewing → sending" for a single report today means a notes textarea. | To honour "the same existing process of editing / previewing", the document-layer pattern must be ported to the single report. Additive, well-precedented. |
| **F4** | **Mobile is a Capacitor wrapper of `public/`.** `bodybank-app/www` is built from this repo's web assets. | No separate mobile component work. One responsive build ships to web, Android and iOS. |
| **F5** | **Naming conflict.** Brief §2 forbids "NURA" in product, code or user-facing text; your instruction asks to name it "BODYBANK-NURA". | Needs your call. Options in §11. |

Everything else in the brief is implementable as specified.

---

## 1. Current architecture

### 1.1 Data flow — upload to delivered report

```
                  MEMBER (public/index.html, 3 upload slots)         STAFF (admin / operator)
                                │                                             │
                 POST /api/blood/upload                   POST /api/blood/admin/upload/:userId
                 · reportDate OPTIONAL                    · reportDate REQUIRED
                 · 3-slot cap enforced                    · no slot cap
                                └─────────────┬───────────────────────────────┘
                                              ▼
                        validateBloodReportInput()  — Haiku: "is this a lab report?"
                                              ▼
                   file → uploads/blood-reports/blood_<uid>_<ts>.<ext>
                   row  → blood_analysis_reports (status='pending')
                                              ▼
              member path: waits for staff "Process now"    │    staff path: auto-starts
                                              ▼
                 triggerBloodAnalysis()   [services/bloodAnalysisService.js]
                                              │
        ┌─────────────────────────────────────┼─────────────────────────────────────┐
        ▼                                     ▼                                     ▼
 PASS 1 — EXTRACTION                 PASS 2 — CLINICAL ANALYSIS            NUTRITION CONTEXT
 Haiku 4.5                           Opus 4.8                              computeNutritionSummary
 ANTHROPIC_MODEL_BLOOD               ANTHROPIC_MODEL_BLOOD_ANALYSIS        ForUserWindow(7 days)
 → extracted_blood_data              → ai_report (13-section JSON)         + avg energy difference
   { lab_name, report_date,            { overall_status,
     panels:[{ name,                     overall_summary_short,
       markers:[{ name, value, unit,     clinical_interpretation,
         reference_range, STATUS,        key_findings[], risks[],
         flag }] }] }                    foods_*, weekly_meal_plan[],
   'extracting' → 'analysing'            supplements[], lifestyle{},
   (reused verbatim on retry)            retest_schedule[] }
        └─────────────────────────────────────┴─────────────────────────────────────┘
                                              ▼
                  generateHealthReportPdfWithFallback()  [services/pdfService.js]
                           → buildHealthReportPdf()      [services/healthReportPdfKit.js]
                  13 dark-green branded sections, PDFKit, empty sections are skipped
                                              ▼
                  uploads/health-reports/BodyBank_Report_<id>_<ts>.pdf
                  status='complete', pdf_path set
                                              ▼
            ┌─────────────────────────────────┼─────────────────────────────┐
            ▼                                 ▼                             ▼
 STAFF card (index.html)         GET /api/blood/pdf/:id        POST /admin/send/:reportId
 · admin_notes textarea          owner | admin | operator      · ensureHealthReportPdf()
 · Retry / Force retry           ensureHealthReportPdf()       · emailHealthReportWithPdf()
 · Download PDF                  regenerates if file gone      · user_inbox row
 · Send to client                                              · sent_to_user = true
 · Lab-date edit, delete                                       · notifyAsync BLOOD_REPORT_SENT
```

### 1.2 The comparison ("progress") report — a different, more mature flow

```
staff picks 2–6 processed reports
      ▼
alignReports(rows)            services/bloodComparisonService.js   — DETERMINISTIC, no AI
  · canonicalizeMarker() via MARKER_ALIASES (~60 synonyms)
  · parseNumericValue() / parseReferenceRange() / deviationFromRange()
  · direction: improving | worsening | stable | changed | na
  · ordered by reportTimelineMs() = report_date ?? created_at, anchored at T12:00
      ▼
generateComparisonVerdict()   Opus 4.8, reasons ONLY over the aligned matrix
      ▼
buildComparisonDoc()          services/comparisonDocument.js   ◀── THE DOCUMENT LAYER
  ordered sections: trend | text | cards | table | callout | disclaimer
  stored in blood_comparison_reports.report_doc (NULL = never edited)
      ▼
bbOpenReportEditor()          public/js/blood-report-editor.js (1,620 LOC)
  edit · hide · reorder · retitle · add/delete sections, rows, columns, cards
  live HTML preview with WinAnsi transliteration parity
      ▼
buildComparisonReportPdf()    renders ONLY the document, never the raw data
      ▼
send by email · in-app · revocable wa.me share link
```

**This second flow is the template for the new variant.** It already solves editing, previewing,
preview/print parity, and safe sanitisation of browser-supplied content.

### 1.3 Schema (current, relevant columns only)

`blood_analysis_reports`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `user_id` | TEXT FK → users | ON DELETE CASCADE |
| `blood_report_file_path` | TEXT | original lab file on disk |
| `symptoms` | JSONB | member-reported, array of strings |
| `extracted_blood_data` | JSONB | **the lab truth** — panels / markers |
| `nutrition_snapshot` | JSONB | 7-day window at analysis time |
| `ai_report` | JSONB | the 13-section clinical analysis |
| `pdf_path` | TEXT | absolute path; NULL forces regeneration |
| `admin_notes` | TEXT | the only "editing" a single report has today |
| `sent_to_user`, `sent_at` | BOOLEAN, TIMESTAMPTZ | |
| `status` | TEXT | pending / extracting / analysing / generating_pdf / complete / failed |
| `report_date` | DATE | **manual, never auto-extracted** (deliberate) |
| `user_name` / `_email` / `_age` / `_gender` / `_goal` | TEXT | snapshot at upload |
| `extraction_ai_usage`, `analysis_ai_usage`, `total_ai_usage` | JSONB | per-call cost |
| `analysis_last_error` | TEXT | surfaced on the admin card |

`blood_comparison_reports` adds `report_ids`, `comparison_data`, `ai_verdict`, `report_doc`,
`doc_updated_at` / `_by`, and the `share_token` family.

A central `ai_usage_events` ledger (`services/aiUsageLedger.js`) records every Anthropic call.

### 1.4 API surface consumed by web, Android and iOS

All under `/api/blood` (JWT via `router.use(verifyToken)`), plus a public `/r/blood/:token`.
`STAFF_ROLES = admin | superadmin | operator` — operators have **full** parity on blood reports.

- **Member:** `POST /upload` · `GET /my-reports` · `GET /my-progress` · `GET /my-comparisons` · `GET /my-comparison/:id/pdf` · `GET /pdf/:reportId` · `GET /file/:reportId` · `DELETE /:reportId`
- **Staff:** `POST /admin/upload/:userId` · `GET /admin/all` · `GET /admin/slots/:userId` · `POST /admin/retry/:id` · `PUT /admin/notes/:id` · `POST /admin/send/:id` · `PUT /admin/report-date/:id` · `GET /impact/:id` · plus the 13 `/admin/compar*` routes

### 1.5 UI inventory

| Surface | Location | Reusable for the new variant? |
|---|---|---|
| Admin Blood Reports tab | `public/index.html` ~L25567 `loadAdminBloodReports` / `adminBloodCardHtml` | **Modify** — variant badge + "Open editor" |
| Staff upload modal | `bbAskLabDate` ~L25276 | **Modify** — the variant picker goes here |
| Operator client modal "Blood" tab | `opBuildBlood` / `opMountBlood` | **Modify** — shares the same helpers, stays identical |
| Comparison workspace | `#bbComparePanel`, `bbCmp*` | Reuse as-is |
| Report editor | `public/js/blood-report-editor.js` + `.css` (2,316 LOC) | **Reuse the pattern**, extend with the new section types |
| Member health screen | `.bb-hr-*` rows ~L1986, `loadMyHealthReports` | **Modify** — variant label on the row |
| Member progress card | `bbLoadMyProgress`, `bbSparkline` | Reuse as-is |

### 1.6 Existing marker → category mapping

**None exists.** Categories today are whatever the lab printed as a panel name
(`"Complete Blood Count"`, `"Lipid Profile"`, `"LIVER FUNCTION TEST"` …), carried verbatim through
extraction into the PDF. `MARKER_ALIASES` canonicalises about 60 marker *names* but assigns no health
area, no weight and no favourable direction. **The health-area map in §4 is entirely new.**

### 1.7 How "change" is determined today

`alignReports()` compares the **first and last numeric value** of each marker and measures
`deviationFromRange()` — the distance outside the parsed reference range. A smaller deviation reads as
`improving`. There is **no clinical-significance threshold**: any movement greater than `1e-9` counts,
so a 1 mg/dL LDL drop reads as `improving` today. Brief §7.2 explicitly forbids that, so the new engine
needs its own threshold table (§5.4). The existing behaviour stays untouched for the existing report.

---

## 2. Proposed architecture

New code is **pure, side-effect-free services** plus one document layer, mirroring the comparison flow.
Nothing below sits on the existing report's code path.

```
            extracted_blood_data  (UNCHANGED — the lab truth)
                          │
                          ▼
      ┌──────────────────────────────────────────────────────┐
      │ services/grading/markerRegistry.js                    │  PURE
      │ canonical id · display · areas[] · weight per area     │
      │ · favourableDirection · preferred range · unit norm    │
      │ reuses normalizeMarkerName() from bloodComparisonSvc   │
      └───────────────────────┬──────────────────────────────┘
                              ▼
      ┌──────────────────────────────────────────────────────┐
      │ services/grading/classify.js                          │  PURE
      │ value + lab range → MarkerStatus  (F1: deterministic)  │
      │ falls back to the extracted status, labelled, when     │
      │ no reference range can be parsed                       │
      └───────────────────────┬──────────────────────────────┘
                              ▼
      ┌──────────────────────────────────────────────────────┐
      │ services/grading/index.js   gradeAreas(markers[])      │  PURE
      │ sufficiency → weights → severity ceiling → patterns    │
      │ → HealthAreaResult[] each carrying gradeRationale[]    │
      └───────────────────────┬──────────────────────────────┘
                              ▼
      ┌────────────────────────────┐   ┌────────────────────────────────┐
      │ services/priority/index.js │   │ services/comparison/index.js   │  PURE
      │ pickPriorities() → max 3   │   │ trends vs the previous report  │
      └──────────────┬─────────────┘   └───────────────┬────────────────┘
                     └─────────────┬──────────────────┘
                                   ▼
      ┌──────────────────────────────────────────────────────┐
      │ services/gradedReportDocument.js                      │
      │ buildGradedDoc() → ordered sections (the IA in §7)     │
      │ sanitizeGradedDoc() → guards browser-supplied input    │
      │ stored in blood_analysis_reports.graded_doc            │
      └───────────────────────┬──────────────────────────────┘
                              ▼
            ┌─────────────────┴──────────────────┐
            ▼                                    ▼
 services/gradedReportPdfKit.js        public/js/graded-report-editor.js
 buildGradedReportPdf(doc)             edit · preview · send  (pattern taken
 renders ONLY the doc                  from blood-report-editor.js)
```

**Where the LLM sits, and where it does not.** Grades, statuses, trends and priority ordering are
100 % deterministic. One optional AI pass writes `insight` / `summary` / `focus` prose **from the
structured `gradeRationale`**, is screened against the prohibited-phrase list, and falls back to a
vetted template on any failure or screen hit. It records to
`recordAiUsage({ scope: 'blood_graded_copy' })` so its cost stays visible in the admin Tokens screen.

---

## 3. Variant selection — how the two reports coexist

One new column drives everything:

```sql
ALTER TABLE blood_analysis_reports
  ADD COLUMN IF NOT EXISTS report_variant TEXT NOT NULL DEFAULT 'classic';
```

`'classic'` is today's report, bit-for-bit. `'graded'` is the new one. **The default makes every
existing row and every existing client build behave exactly as it does now.**

| Path | Behaviour |
|---|---|
| Staff upload (`/admin/upload/:userId`) | Variant picker in the existing `bbAskLabDate` modal, beside the lab date. Required, nothing preselected. |
| Member upload (`/upload`) | Always `'classic'`. Members never see a variant choice. |
| Retry / "Process now" | Uses the row's stored variant. |
| **Switch variant later** | `PUT /api/blood/admin/variant/:reportId` re-runs *only* the new engines off the saved `extracted_blood_data` — **no re-extraction, no re-analysis, zero AI cost** when the copy pass is off. This is the answer to "we picked the wrong one". |
| Send / download / delete / lab-date / comparison | Unchanged routes; they branch on `report_variant` only where they choose a PDF builder. |

Both variants share the same upload, extraction, storage, slot, timeline, send and delete machinery.
Only the **analysis → document → PDF** leg differs.

### 3.1 Does the graded variant still run the Opus clinical pass?

Three options; decision needed at this gate.

| | Opus clinical pass | Graded engines | Cost / report | Report content |
|---|---|---|---|---|
| **A** | skipped | yes | **~$0.03** (extraction only) | Grades, priorities, areas, markers, next steps. No meal plan, no supplement doses, no long clinical narrative. |
| **B — recommended** | kept as-is | yes | ~$0.20–0.33 (as today) | Everything in A, plus the existing clinical narrative, foods, meal plan and supplements appended as later sections the reviewer can hide. |
| **C** | kept, new prompt | yes | ~$0.20–0.33 | As B but with a prompt rewritten for the graded IA. Highest ceiling, highest risk — a new prompt is new behaviour to validate. |

**Recommendation: B.** It reuses proven output, keeps the client's report as rich as it is today, adds
the grading layer on top, and lets the reviewer delete anything that does not belong. It also degrades
gracefully: if the Opus pass fails, the grades still render.

---

## 4. Health-area mapping table

Canonical IDs are new and stable. `w` is clinical weight within that area (1 = low, 2 = moderate,
3 = high, 4 = dominant). A marker appearing in two areas carries a separate weight in each.

### 4.1 Cardiovascular — `CARDIOVASCULAR`

*Minimum to grade: (LDL_C **or** NON_HDL_C) **and** (HDL_C **or** TRIGLYCERIDES)*

| Canonical ID | Display | Unit | Favourable | w | Notes |
|---|---|---|---|---|---|
| `LDL_C` | LDL Cholesterol | mg/dL | LOWER | 4 | |
| `NON_HDL_C` | Non-HDL Cholesterol | mg/dL | LOWER | 4 | derived when absent: TC − HDL, labelled *calculated* |
| `APO_B` | Apolipoprotein B | mg/dL | LOWER | 4 | rarely present on Indian panels |
| `LP_A` | Lipoprotein(a) | nmol/L or mg/dL | LOWER | 3 | unit ambiguity — see risk R4 |
| `TRIGLYCERIDES` | Triglycerides | mg/dL | LOWER | 3 | shared with Metabolic (w2) |
| `HDL_C` | HDL Cholesterol | mg/dL | HIGHER | 3 | |
| `TOTAL_CHOL` | Total Cholesterol | mg/dL | LOWER | 1 | **correlated with LDL_C** — joint, not additive |
| `VLDL_C` | VLDL Cholesterol | mg/dL | LOWER | 1 | correlated with TRIGLYCERIDES |
| `CHOL_HDL_RATIO` | Total / HDL Ratio | ratio | LOWER | 2 | derived, correlated |
| `HS_CRP` | hs-CRP | mg/L | LOWER | 2 | shared with Inflammation (w4) |

### 4.2 Metabolic — `METABOLIC`

*Minimum: FASTING_GLUCOSE **or** HBA1C*

| ID | Display | Unit | Fav. | w | Notes |
|---|---|---|---|---|---|
| `HBA1C` | HbA1c | % | LOWER | 4 | outweighs a single glucose |
| `FASTING_GLUCOSE` | Fasting Glucose | mg/dL | LOWER | 3 | |
| `FASTING_INSULIN` | Fasting Insulin | µIU/mL | LOWER | 3 | |
| `HOMA_IR` | HOMA-IR | index | LOWER | 3 | derived from glucose × insulin; correlated with both |
| `TRIGLYCERIDES` | Triglycerides | mg/dL | LOWER | 2 | shared |
| `POST_PRANDIAL_GLUCOSE` | Post-prandial Glucose | mg/dL | LOWER | 2 | |

### 4.3 Liver — `LIVER`

*Minimum: ALT **and** at least one of AST / ALP / GGT / BILIRUBIN_TOTAL*

| ID | Display | Unit | Fav. | w | Notes |
|---|---|---|---|---|---|
| `ALT` | ALT (SGPT) | U/L | LOWER | 4 | |
| `AST` | AST (SGOT) | U/L | LOWER | 3 | **correlated with ALT** — joint |
| `GGT` | GGT | U/L | LOWER | 3 | |
| `ALP` | Alkaline Phosphatase | U/L | RANGE | 2 | |
| `BILIRUBIN_TOTAL` | Total Bilirubin | mg/dL | LOWER | 2 | |
| `BILIRUBIN_DIRECT` | Direct Bilirubin | mg/dL | LOWER | 2 | correlated with total |
| `ALBUMIN` | Albumin | g/dL | RANGE | 2 | |
| `TOTAL_PROTEIN` | Total Protein | g/dL | RANGE | 1 | correlated with albumin |
| `GLOBULIN` / `AG_RATIO` | Globulin / A:G Ratio | g/dL, ratio | RANGE | 1 | derived, correlated |

### 4.4 Kidney — `KIDNEY`

*Minimum: CREATININE **or** EGFR*

| ID | Display | Unit | Fav. | w | Notes |
|---|---|---|---|---|---|
| `EGFR` | eGFR | mL/min/1.73m² | HIGHER | 4 | outweighs BUN |
| `CREATININE` | Creatinine | mg/dL | LOWER | 3 | correlated with eGFR — joint |
| `CYSTATIN_C` | Cystatin C | mg/L | LOWER | 3 | |
| `UREA` / `BUN` | Urea / BUN | mg/dL | LOWER | 2 | **unit trap:** Urea ≈ BUN × 2.14 — see risk R4 |
| `URIC_ACID` | Uric Acid | mg/dL | LOWER | 2 | |
| `SODIUM` | Sodium | mmol/L | RANGE | 2 | |
| `POTASSIUM` | Potassium | mmol/L | RANGE | 3 | narrow safe band |
| `CHLORIDE` | Chloride | mmol/L | RANGE | 1 | |

### 4.5 Thyroid — `THYROID`

*Minimum: TSH*

| ID | Display | Unit | Fav. | w |
|---|---|---|---|---|
| `TSH` | TSH | µIU/mL | RANGE | 4 |
| `FREE_T4` | Free T4 | ng/dL | RANGE | 3 |
| `FREE_T3` | Free T3 | pg/mL | RANGE | 2 |
| `ANTI_TPO` | Anti-TPO Antibodies | IU/mL | LOWER | 2 |
| `TOTAL_T3` / `TOTAL_T4` | Total T3 / T4 | ng/dL, µg/dL | RANGE | 1 (correlated with the free forms) |

### 4.6 Blood — `BLOOD`

*Minimum: HEMOGLOBIN **and** at least two of RBC / HEMATOCRIT / MCV / WBC / PLATELETS*

| ID | Display | Unit | Fav. | w | Notes |
|---|---|---|---|---|---|
| `HEMOGLOBIN` | Hemoglobin | g/dL | RANGE | 4 | |
| `HEMATOCRIT` | Hematocrit (PCV) | % | RANGE | 2 | **correlated with Hb** — joint |
| `RBC` | RBC Count | mill/µL | RANGE | 2 | correlated with Hb |
| `MCV` | MCV | fL | RANGE | 3 | the anaemia-type discriminator |
| `MCH` / `MCHC` | MCH / MCHC | pg, g/dL | RANGE | 2 | correlated with MCV |
| `RDW` | RDW | % | LOWER | 2 | |
| `WBC` | WBC (TLC) | /µL | RANGE | 3 | |
| `PLATELETS` | Platelets | /µL | RANGE | 3 | |
| `NEUTROPHILS` `LYMPHOCYTES` `EOSINOPHILS` `MONOCYTES` `BASOPHILS` | Differential | % | RANGE | 1 each | shared with Inflammation |

### 4.7 Nutritional — `NUTRITIONAL`

*Minimum: any two nutritional markers*

| ID | Display | Unit | Fav. | w | Notes |
|---|---|---|---|---|---|
| `VITAMIN_D` | Vitamin D (25-OH) | ng/mL | HIGHER | 3 | |
| `VITAMIN_B12` | Vitamin B12 | pg/mL | HIGHER | 3 | |
| `FOLATE` | Folate | ng/mL | HIGHER | 2 | |
| `FERRITIN` | Ferritin | ng/mL | RANGE | 3 | acute-phase reactant — see pattern P3 |
| `SERUM_IRON` | Serum Iron | µg/dL | RANGE | 2 | correlated with TSAT |
| `TIBC` | TIBC | µg/dL | RANGE | 1 | correlated |
| `TRANSFERRIN_SAT` | Transferrin Saturation | % | RANGE | 2 | derived, correlated |
| `CALCIUM` | Calcium | mg/dL | RANGE | 2 | |
| `MAGNESIUM` | Magnesium | mg/dL | RANGE | 2 | |
| `ZINC` | Zinc | µg/dL | RANGE | 1 | |
| `PHOSPHORUS` | Phosphorus | mg/dL | RANGE | 1 | |

### 4.8 Inflammation / Immune — `INFLAMMATION`

*Minimum: HS_CRP **or** ESR*

| ID | Display | Unit | Fav. | w |
|---|---|---|---|---|
| `HS_CRP` | hs-CRP | mg/L | LOWER | 4 |
| `CRP` | CRP (standard) | mg/L | LOWER | 3 |
| `ESR` | ESR | mm/hr | LOWER | 3 |
| `WBC` and differential | | | RANGE | 1 each |

### 4.9 Body Composition — `BODY_COMPOSITION`

*Minimum: an actual BodyBank measurement.* **Never inferred from blood markers.** Sourced from
`body_snapshots` / smart-scale data when present, otherwise `NOT_ASSESSED`.

### 4.10 `UNMAPPED`

Everything else — urinalysis, hormone panels (testosterone, cortisol, prolactin, LH/FSH), serology,
tumour markers, unrecognised names — renders in the **"Other Results"** group of the detailed lab
table with full RESULT and STATUS, no grade and no insight. **Never dropped.**

The registry ships with roughly 180 alias strings mapping onto about 85 canonical IDs — a superset of
the existing `MARKER_ALIASES`. It **reuses** `normalizeMarkerName()` from `bloodComparisonService`
(imported, not copied) so the two canonicalisers cannot disagree. `MARKER_ALIASES` itself is not modified.

---

## 5. Methodology

### 5.1 Deterministic status classification (resolves F1)

For each marker, in order:

1. Parse the value with the existing `parseNumericValue()` (handles `13.5 g/dL`, `<0.1`, `5,000`).
2. Parse the lab's printed range with the existing `parseReferenceRange()`.
3. If both parse → derive the status arithmetically:
   - inside the range → `WITHIN_RANGE`
   - within 5 % of a bound, on the inside → `BORDERLINE_LOW` / `BORDERLINE_HIGH`
   - outside a bound → `LOW` / `HIGH`
   - beyond the per-marker critical multiplier in the registry → `CRITICAL_LOW` / `CRITICAL_HIGH`
4. If the range does not parse but the registry holds a **BodyBank preferred range** → use it and label
   the row *"BodyBank preferred range"* in the UI (§12.1 of the brief).
5. If neither is available → fall back to the extracted (LLM) status, flagged
   `statusSource: 'EXTRACTED'`, and **excluded from grading** — it can never move a grade.
6. No value → `NOT_AVAILABLE`.

Every `MarkerResult` carries `statusSource: 'DERIVED_LAB' | 'DERIVED_PREFERRED' | 'EXTRACTED'`, which is
what the safety tests assert against.

### 5.2 Grading rules

1. **Sufficiency first.** Minimum marker set unmet → `NOT_ASSESSED`, with `markersMissing` naming what
   was absent. Never a guess.
2. **Weighted, never counted.** No `abnormal ÷ total` anywhere.
3. **Severity ceilings.** Any `CRITICAL_*` → the area cannot rise above **D**. Any `HIGH` / `LOW` on a
   marker of weight ≥ 3 → cannot rise above **C**. Any `BORDERLINE_*` → cannot rise above **B**.
   Ceilings are applied last, so a pattern rule can lower a grade but never raise it past its ceiling.
4. **Pattern rules** (encoded, each emitting its own rationale line):
   - **P1 — Atherogenic dyslipidaemia:** TG high + HDL low → `CARDIOVASCULAR` ≥ C.
   - **P2 — Metabolic cluster:** TG high + HDL low + (fasting glucose ≥ borderline high **or** HbA1c ≥ borderline high) → `METABOLIC` ≥ C.
   - **P3 — Iron-deficiency anaemia:** Hb low + MCV low + ferritin low → `BLOOD` ≥ C, `NUTRITIONAL` ≥ C. Suppressed when hs-CRP or ESR is high (ferritin is an acute-phase reactant) — instead emits a "ferritin may be falsely raised by inflammation" rationale.
   - **P4 — Macrocytic pattern:** Hb low + MCV high → `BLOOD` ≥ C, and `NUTRITIONAL` ≥ C when B12 or folate is low.
   - **P5 — Hepatocellular pattern:** ALT and AST both high, or either > 2× the upper bound → `LIVER` ≥ C; > 3× → D.
   - **P6 — Cholestatic pattern:** ALP high + GGT high → `LIVER` ≥ C.
   - **P7 — Reduced filtration:** eGFR < 60 → `KIDNEY` ≥ C; < 30 → D.
   - **P8 — Subclinical thyroid pattern:** TSH out of range with Free T4 in range → `THYROID` ≥ B and never worse than C on TSH alone.
   - **P9 — Diabetic range:** HbA1c ≥ 6.5 % or fasting glucose ≥ 126 mg/dL → `METABOLIC` = D.
5. **Correlation guard.** Markers sharing a `correlationGroup` in the registry contribute the
   **maximum** weighted deviation in the group, not the sum. Groups: `{TOTAL_CHOL, LDL_C}`,
   `{TRIGLYCERIDES, VLDL_C}`, `{HEMOGLOBIN, HEMATOCRIT, RBC}`, `{MCV, MCH, MCHC}`, `{ALT, AST}`,
   `{CREATININE, EGFR}`, `{BILIRUBIN_TOTAL, BILIRUBIN_DIRECT}`, `{ALBUMIN, TOTAL_PROTEIN, GLOBULIN}`,
   `{SERUM_IRON, TIBC, TRANSFERRIN_SAT}`, `{HS_CRP, CRP}`, `{FASTING_GLUCOSE, FASTING_INSULIN, HOMA_IR}`.
6. **Reference-range authority.** The lab's range decides status. A BodyBank preferred range is used
   only where the registry documents one, and is always labelled in the UI.
7. **Rationale is mandatory.** Every grade emits an ordered `gradeRationale[]` naming the rules that
   fired: `["SUFFICIENCY_MET", "CEILING_C:LDL_C=HIGH(w4)", "PATTERN_P1", "FINAL=C"]`.
8. **Deterministic.** No LLM, no clock, no randomness in the grading path. Same input, same grade.

### 5.3 Overall score

Not implemented, per brief §6.4. Logged as backlog item **BL-1** in §10.

### 5.4 Comparison thresholds

A change must clear **both** the absolute and the percentage bar (whichever the registry defines) to be
anything other than `NO_SIGNIFICANT_CHANGE`. Starting table — every row needs sign-off from your
clinical reviewer before Phase 1 ships:

| Marker | Threshold | Basis |
|---|---|---|
| `LDL_C` | ≥ 10 mg/dL or ≥ 10 % | brief §7.2; within typical assay + biological variation |
| `NON_HDL_C` | ≥ 10 mg/dL or ≥ 10 % | mirrors LDL |
| `HDL_C` | ≥ 5 mg/dL | |
| `TRIGLYCERIDES` | ≥ 30 mg/dL or ≥ 20 % | high intra-individual variability |
| `TOTAL_CHOL` | ≥ 15 mg/dL | |
| `HBA1C` | ≥ 0.3 % | brief §7.2 |
| `FASTING_GLUCOSE` | ≥ 10 mg/dL | |
| `EGFR` | ≥ 5 mL/min/1.73m² | brief §7.2 |
| `CREATININE` | ≥ 0.2 mg/dL | |
| `ALT` / `AST` / `GGT` | ≥ 10 U/L or ≥ 25 % | |
| `TSH` | ≥ 0.5 µIU/mL | |
| `VITAMIN_D` | ≥ 5 ng/mL | brief §7.2 |
| `VITAMIN_B12` | ≥ 50 pg/mL | |
| `FERRITIN` | ≥ 20 ng/mL or ≥ 25 % | |
| `HEMOGLOBIN` | ≥ 0.5 g/dL | |
| `PLATELETS` | ≥ 30,000 /µL | |
| `HS_CRP` | ≥ 1.0 mg/L or ≥ 50 % | |
| *(unlisted)* | ≥ 10 % of the previous value | conservative default; the rationale says "default threshold" |

Additional rules: unit mismatch that the registry cannot normalise → `NOT_COMPARABLE` (never a silent
conversion). No previous report → no progress report at all, and the health report reads
*"First screening — trends will appear on your next report."* Screenings less than 4 weeks apart carry a
*"short interval — changes may not be meaningful"* banner. Area trend is the grade delta plus the single
highest weighted contributor as `trendDriver`.

### 5.5 Priority selection

Scored in the brief's order — grade D first, then severity tier, then clinical weight, then unfavourable
trend, then actionability. Ties break on canonical marker ID, ascending, so renders are stable. Two
priorities from the same `correlationGroup` are never both listed. Fewer than three qualifying findings
produces fewer cards; the section is never padded.

---

## 6. Domain model

**The repo is plain CommonJS JavaScript — there is no TypeScript and no build step.** The brief's §5
interfaces ship as **JSDoc typedefs** in `services/grading/types.js`, which gives editor-level checking
and documentation without a toolchain change. Field names and enum values match the brief exactly, plus
three additions:

- `MarkerResult.statusSource` — `'DERIVED_LAB' | 'DERIVED_PREFERRED' | 'EXTRACTED'` (§5.1)
- `MarkerResult.areaIds[]` — a shared marker belongs to more than one area
- `HealthReport.rulesetVersion` — alongside `engineVersion`, for the audit trail in brief §12.2

---

## 7. Report page structure

### 7.1 Health Report — document sections

| # | Section | Section type | Notes |
|---|---|---|---|
| 0 | **Critical findings** | `callout` | Rendered **only** when a `CRITICAL_*` status exists; sits above everything (brief §12.1). |
| 1 | Header / cover | cover | Client, screening date, report ID, BodyBank branding, DEMO watermark for fixtures |
| 2 | **Health Map** | `healthmap` *(new type)* | Grade badge + label per assessed area. No marker values. Page-1 hero. |
| 3 | Key Message | `text` | One neutral framing sentence |
| 4 | Not assessed | `notassessed` *(new)* | Areas below sufficiency, with the missing markers named |
| 5 | **Top Priorities** | `priorities` *(new)* | Up to 3 cards: title · why it matters · your result · grade · next step |
| 6 | Health Areas | `areacards` *(new)* | One card per assessed area, ordered D → C → B → A |
| 7 | Detailed Lab Results | `markertable` *(new)* | Every marker, grouped by area, "Other Results" last |
| 8 | *(variant B only)* Clinical interpretation, foods, meal plan, supplements, lifestyle, retests | `text` / `table` / `cards` | Reused from the existing `ai_report`; each hideable |
| 9 | Your Next Steps | `table` | 3–5 actions, professional flags |
| 10 | Coach's note | `callout` | Syncs with `admin_notes`, as the comparison report does |
| 11 | Disclaimer | `disclaimer` | Always present, never collapsed in the PDF |

Every marker row and area card renders the four fixed labels — **RESULT · STATUS · BODYBANK INSIGHT ·
NEXT STEP** — with interpretation typographically distinct from measured values.

### 7.2 Health Progress — document sections

Header (with interval) → Progress Map (previous → current per area) → Progress Summary (Improved /
Stable / Needs Attention) → New & Resolved → Area Progress Cards → Full Comparison Table → Next Steps →
Disclaimer. Fixed trend vocabulary: `↑ Improved` · `→ Stable` · `↓ Needs Attention` · `New Finding` ·
`Resolved` · `No Significant Change`. Never "better" or "worse" as a standalone label.

### 7.3 PDF pagination

Page 1 = Header + Health Map + Key Message. Page 2 = Priorities. Enforced with explicit page breaks in
the document, so print hierarchy survives regardless of content length.

---

## 8. Component inventory

Because of **F4**, "web and mobile" is one responsive build. Components are vanilla-JS render functions
in a new `public/js/graded-report-view.js` plus `public/css/graded-report.css`, matching how
`blood-report-editor.js` is written — no framework is introduced.

| Component | Status | Notes |
|---|---|---|
| `HealthGradeBadge` | **New** | Letter + label + non-colour shape. Greyscale- and colour-blind-safe. |
| `HealthMap` | **New** | `variant: 'current' \| 'progress'`; grid → 2×N → vertical stack |
| `HealthAreaCard` | **New** | Collapsed by default on mobile |
| `PriorityCard` | **New** | All five fields plus the professional flag |
| `MarkerRow` | **New** | RESULT / STATUS / INSIGHT layers; becomes a card below 600 px |
| `MarkerStatusPill` | **New** | Text + shape, never colour alone |
| `TrendIndicator` | **Adapt** | Extends `bbSparkline` / arrow logic from `bbLoadMyProgress` |
| `ComparisonCard` | **New** | Previous → current grade with driver |
| `ProgressGroup` | **New** | |
| `LabResultTable` | **New** | Grouped, sortable |
| `ReportKeyMessage` | **New** | |
| `NextStepsList` | **New** | |
| `MedicalDisclaimer` | **Adapt** | Reuses the fixed copy path |
| `NotAssessedNotice` | **New** | |
| Report editor shell | **Adapt** | `graded-report-editor.js` forked from `blood-report-editor.js`: same shell, toolbar, save/preview/send, WinAnsi transliteration parity, new section renderers |
| Variant picker | **Modify** | Added to `bbAskLabDate` |
| Admin / operator card | **Modify** | Variant badge + "Open editor" button |
| PDF builder | **New** | `gradedReportPdfKit.js`, reusing the brand constants and vector-glyph helpers from `healthReportPdfKit.js` |

Every component consumes the typed document only. **No component grades, compares or prioritises.**

---

## 9. Data-flow and schema changes

All additive and reversible.

```sql
-- 1. which report the client gets
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS report_variant TEXT NOT NULL DEFAULT 'classic';

-- 2. deterministic engine output (grades, markers, priorities, rationale)
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS graded_report JSONB;

-- 3. the editable document that the PDF renders from
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS graded_doc JSONB;
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS graded_doc_updated_at TIMESTAMPTZ;
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS graded_doc_updated_by TEXT DEFAULT '';

-- 4. audit trail (brief §12.2)
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS engine_version TEXT;
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS ruleset_version TEXT;

-- 5. separate PDF path so the two variants never overwrite each other
ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS graded_pdf_path TEXT;

CREATE INDEX IF NOT EXISTS idx_blood_reports_variant ON blood_analysis_reports(report_variant);
```

Rollback is `DROP COLUMN` on six columns plus one index; no existing column is altered and no data is
migrated. These go in `initDb()` in `server.js` as `ADD COLUMN IF NOT EXISTS` inside `try/catch`,
matching every other migration in this codebase.

### New endpoints (v1 untouched)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v2/blood/reports/:id/health` | The typed `HealthReport` |
| `GET` | `/api/v2/blood/reports/:id/progress` | The progress model |
| `GET` | `/api/blood/admin/report/:id/graded-doc` | Load the editable document |
| `PUT` | `/api/blood/admin/report/:id/graded-doc` | Save it (clears `graded_pdf_path`) |
| `POST` | `/api/blood/admin/report/:id/graded-doc/reset` | Rebuild the default document |
| `PUT` | `/api/blood/admin/variant/:id` | Switch variant, re-run engines off saved extraction |

Existing endpoints keep their exact shapes. `mapReportRow()` gains `reportVariant` — an **added** field,
which older mobile builds ignore. `GET /pdf/:reportId` branches internally on the variant and keeps its
signature, so every current client keeps working with no change.

### Untouched by design

Twilio / WhatsApp hooks, `notifyAgent` events, the AI-usage ledger schema, the comparison flow, upload
slots, the `/uploads/health-reports` 404 guard (the new PDFs land in the same already-protected
directory), and every member-facing route.

---

## 10. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **R1** | **Existing defect — LLM-authored status.** Haiku assigns `Normal / High / Low` during extraction using "standard adult clinical ranges" when none is printed. That is an undocumented, unauditable clinical judgement already reaching clients today, in both variants. | Certain | High | §5.1 replaces it deterministically **for the graded variant only**. The classic variant is left exactly as it is. *Recommend a follow-up decision on the classic report — flagged, not fixed, per brief §19.* |
| **R2** | **Existing defect — no significance threshold in comparisons.** Any numeric movement reads as `improving` / `worsening` in the current progress report and the member's live trend card. | Certain | Medium | The new comparison engine has thresholds. Existing behaviour deliberately unchanged. *Recommend a follow-up.* |
| **R3** | `mapReportRow()` gains a field. | Certain | Low | Additive only. Android / iOS builds parse JSON leniently; no client enumerates keys. Regression test asserts every existing key still present with the same value. |
| **R4** | **Unit ambiguity** — Urea vs BUN (×2.14), Lp(a) mg/dL vs nmol/L, glucose mg/dL vs mmol/L, B12 pg/mL vs pmol/L. A wrong conversion produces a wrong grade. | Medium | **High** | The registry declares accepted units per marker. Anything unrecognised → `NOT_ASSESSED` for that marker with a rationale line. **Never guess a conversion.** Unit-mismatch tests per marker family. |
| **R5** | Indian lab panels frequently omit hs-CRP, ApoB, Lp(a), Free T3/T4, insulin. Many areas will read `NOT_ASSESSED`. | High | Medium | This is correct behaviour, but it must not look like a broken report. The "Not assessed" section explains *which* test would unlock each area — turning a gap into a next step. Validate against 10 real historical reports before shipping. |
| **R6** | AI-written insight copy emits a prohibited phrase or a diagnosis. | Medium | **High** | Programmatic prohibited-phrase screen on every generated string; template fallback on any hit; the copy pass can be disabled entirely by env (`BLOOD_GRADED_AI_COPY=false`) with templates only. Copy never touches RESULT or STATUS. |
| **R7** | Grade misread as a diagnosis by a client. | Medium | **High** | Fixed grade labels ("Attention Recommended", never "Bad"), mandatory disclaimer, mandatory "Discuss with your healthcare professional" on every D, and no organ-level absolutes. |
| **R8** | **Concurrent Claude sessions edit this repo.** The working tree already carries uncommitted changes to `server.js`, `public/index.html`, `public/part2-form.html`, and the branch is `hotfix/boot-crash`. | High | Medium | Work on a dedicated branch off `main`. Touch `server.js` and `index.html` with validate-then-atomic-replace patches only. Never rewrite either file wholesale. |
| **R9** | `public/index.html` is a ~1.1 MB single file; adding several thousand lines makes it worse. | Certain | Low | All new UI ships as `public/js/graded-report-*.js` + `public/css/graded-report.css`. Only the variant picker, the badge and the editor launch button touch `index.html` (< 100 lines). |
| **R10** | PDFKit Helvetica is WinAnsi-only; `→`, `≥`, `–` print as garbage. | Certain if ignored | Medium | Reuse the existing transliteration map and vector-glyph helpers from `comparisonReportPdfKit.js` / `healthReportPdfKit.js`. Editor mirrors the same map, as it already does. |
| **R11** | The graded PDF overwrites the classic one. | Medium | Medium | Separate `graded_pdf_path` column and a distinct filename prefix (`BodyBank_Graded_<id>_<ts>.pdf`). |
| **R12** | Regenerating a report yields a different grade (non-idempotent). | Low | High | No clock, no randomness, no LLM in the grading path. The idempotence test regenerates a fixture 50× and asserts identical grades and rationale. |
| **R13** | Demo fixtures leak into a client render. | Low | High | Fixtures live only under `fixtures/demo/`; a `__demo: true` flag forces a visible DEMO DATA watermark; a test asserts no demo path can be reached from a `blood_analysis_reports` row. |
| **R14** | Cost creep if the copy pass runs on every regeneration. | Medium | Low | Generated copy is cached in `graded_report`; regeneration reuses it unless the values changed. Every call goes through `recordAiUsage`. |

### Backlog (explicitly deferred)

- **BL-1** — single 0–100 overall score (brief §6.4)
- **BL-2** — deterministic status classification for the *classic* variant (R1)
- **BL-3** — significance thresholds for the *existing* comparison engine (R2)
- **BL-4** — member-facing in-app HTML report, if F2 is answered "PDF only" for now

---

## 11. Naming — decision needed (F5)

Brief §2 prohibits the reference product's name anywhere in the product, code or user-facing text; your
instruction asks for "BODYBANK-NURA report". These cannot both hold. Three ways forward:

| Option | Internal code | User-facing name | Trade-off |
|---|---|---|---|
| **A — recommended** | `report_variant = 'graded'` | **BodyBank Health Map Report** | Fully compliant with §2. Describes what it is. No third-party name anywhere. |
| **B** | `report_variant = 'graded'` | "BodyBank-NURA Report" **staff-only**, never on the client PDF | Keeps your shorthand where your team works, keeps the client artefact clean. Still puts the name in the UI. |
| **C** | `report_variant = 'nura'` | "BODYBANK-NURA Report" everywhere | Matches your instruction literally, contradicts §2, and puts another company's name on a medical document you send to clients. **Not recommended.** |

Alternative user-facing names if A appeals but the wording does not: *BodyBank Preventive Health Report*,
*BodyBank Graded Health Report*, *BodyBank Health Grade Report*.

The variant key is internal and cheap to change before Phase 1; renaming it after reports exist means a
data migration. **Please pick at this gate.**

---

## 12. Regression plan

**Goal: prove the existing report is untouched at the data layer.**

1. **Golden capture, before any change.** `scripts/capture-blood-golden.js` reads every
   `blood_analysis_reports` row (or a chosen sample plus `scripts/sample_health_report_data.json`, the
   Rahul Sharma fixture) and writes, per report: every marker name / value / unit / reference range /
   status, the full `ai_report` JSON, the `alignReports()` output for every comparison, and a SHA-256 of
   the generated classic PDF bytes.
2. **After implementation, assert equality.** `tests/blood-golden-regression.js` regenerates each and
   asserts byte-level equality of the extraction and analysis JSON, field-level equality of the aligned
   comparison matrix, and identical classic-PDF content (excluding the generation timestamp, which is the
   only intentionally varying byte range).
3. **API contract test.** `tests/blood-api-contract.js` snapshots the JSON keys of every existing
   `/api/blood/*` response and fails on any **removed or changed** key. Added keys pass — that is the
   additive contract.
4. **Boot test.** The migrations run in `initDb()` against a fresh and an existing database; the app
   boots both ways. (This repo has a live memory of a boot crash from route wiring — the current branch
   is literally `hotfix/boot-crash`, so this check is not theoretical.)
5. **New-engine suites**, per brief §17: grading units (sufficiency boundaries, every severity ceiling,
   every pattern rule, correlation guards, deterministic tie-breaks), comparison units (every `Trend`
   state, direction semantics, threshold edges, unit mismatch, missing previous), priority units
   (D-first, max three, no correlated duplicates, no padding), and safety units (prohibited-phrase scan
   over every rendered string, no LLM string in RESULT/STATUS, disclaimer on every render and every PDF).
6. **Idempotence.** 50 regenerations of one fixture → identical grades and rationale (R12).
7. **Visual QA.** Headless-Chrome screenshots at 390 px / 768 px / 1280 px plus PDF page renders, in
   colour and greyscale, using the workflow already documented for this repo.

All new suites are added to `npm run test:units`, which is where this project's unit tests already live.

---

## 13. Open questions for the gate

1. **Naming (F5)** — option A, B or C from §11?
2. **Clinical pass (§3.1)** — option A, B or C? (Recommendation: B.)
3. **Scope of the web surface (F2)** — pick one:
   - **(i)** PDF + staff editor preview only. Members keep downloading a PDF. *Smallest change, matches "the same existing process" most literally.*
   - **(ii)** (i) plus a member-facing in-app HTML report. *Delivers §15's mobile reading order to clients, and is where the grading layer actually shines.*
4. **Deterministic status (F1)** — confirm the graded variant may override the extracted status. Without
   this the grading engine cannot satisfy §12.1.
5. **Clinical sign-off** — who reviews the §4 weights, the §5.2 pattern rules and the §5.4 thresholds
   before Phase 1 ships? These are the clinical core; I should not be the last reader.
6. **Preferred ranges** — may BodyBank publish preferred ranges (labelled) where a lab prints none, or
   should a missing range always mean `NOT_ASSESSED` for that marker?
7. **Real reports for validation (R5)** — can you point me at 10 representative historical reports, or
   should I work from the existing sample fixture plus synthetic panels?
8. **R1 / R2 follow-ups** — do you want the two existing defects fixed in the classic report as a
   separate piece of work, or left as documented backlog?

---

## 14. Phase 1 plan (on approval)

| Step | Deliverable | Depends on |
|---|---|---|
| 1 | Branch off `main`; golden capture script + baseline snapshot | — |
| 2 | `services/grading/` — registry, classify, types, rules + full unit tests | Q4, Q5, Q6 |
| 3 | `services/comparison/` — thresholds, trends + full unit tests | Q5 |
| 4 | `services/priority/` + tests | 2, 3 |
| 5 | Migrations, `graded_report` persistence, engine wiring behind the variant flag | Q2 |
| 6 | `services/gradedReportDocument.js` + document tests | 5 |
| 7 | `services/gradedReportPdfKit.js` + PDF snapshot tests | 6 |
| 8 | v2 endpoints + admin document endpoints + API contract test | 5 |
| 9 | Variant picker, admin/operator card changes, `graded-report-editor.js` | 8 |
| 10 | *(if Q3 = ii)* member-facing HTML report | 9 |
| 11 | Safety suite, golden regression, idempotence, visual QA | all |
| 12 | `docs/health-report-redesign/METHODOLOGY.md`, changelog, rollback instructions | all |

Steps 2–4 are pure and independently testable; they can be reviewed before anything touches the database.

---

*Engine version at Phase 1 start: `grading@0.1.0`, ruleset `bb-health-areas@2026-09`.*
