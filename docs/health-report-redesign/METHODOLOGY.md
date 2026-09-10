# BodyBank Health Map Report — Methodology

**For clinical review.** This document describes, in plain language, exactly how the BodyBank Health Map
Report decides what it says. It is written to be read by a clinician who has not seen the code.

**Engine** `bb-grading@1.0.0` · **Ruleset** `bb-health-areas@2026-09-1` · **Registry** `bb-markers@2026-09-1`

Every generated report stores these three version stamps plus the full rule trace, so any grade can be
reproduced and explained later.

---

## 1. What this report is, and what it is not

The Health Map Report is a **presentation layer** over a client's own laboratory results. It does not
measure anything, does not re-test anything, and does not add clinical data. It takes the values a lab
printed and organises them so a client can see, in about ten seconds, what is worth their attention.

Grades A–D are a **BodyBank product framework**, not diagnostic categories. They are described to the
client as *Healthy*, *Monitor*, *Attention Recommended* and *Further Evaluation*. Every report carries a
disclaimer stating that grades are not a medical diagnosis, and that disclaimer cannot be deleted,
hidden or emptied by any editing path.

**Three things the system will never do:**

1. **Name a condition.** No output can say "you have X", "this indicates X", or "you are diagnosed with
   X". A programmatic phrase scan runs over every string the report can emit and fails the build if one
   appears.
2. **Assert the absence of disease.** "Your liver is healthy" is not a sentence a liver panel supports,
   and the copy templates cannot produce it.
3. **Grade on insufficient data.** Every health area declares a minimum marker set. If it is not met,
   the area reports as *Not Assessed* and the report names the missing tests.

---

## 2. Where each number comes from

```
Lab report (PDF / image)
      │
      ▼  extraction  — unchanged from the existing BodyBank pipeline
extracted values, units and printed reference ranges
      │
      ▼  classification — arithmetic only, no language model
status per marker  +  the source of that status
      │
      ▼  grading — weighted, correlation-guarded, pattern-aware
grade per health area  +  the ordered list of rules that fired
      │
      ▼  comparison — against the client's previous screening, if one exists
trend per marker and per area
      │
      ▼  priority — at most three findings
      │
      ▼  document — reviewed and editable by a coach or doctor
      │
      ▼  PDF to the client
```

No language model participates in classification, grading, comparison or prioritisation. Those are
arithmetic and produce the same answer every time. The report's prose comes from fixed templates.

---

## 3. Marker status: how "above range" is decided

For each marker, in order:

1. **The lab's printed reference range is the authority.** The value is compared against it directly.
   No unit conversion is involved, because the lab prints both in the same unit.
2. **If the lab printed no range**, and BodyBank holds a documented preferred range for that marker,
   and the printed unit is one we recognise, that range is used — and the report labels the row
   *"BodyBank preferred range"* wherever it appears, with a footnote on the results table.
3. **If neither is available**, the report shows the value with the status the extraction step read off
   the page, marks it as such, and **excludes it from grading entirely**. It cannot move a grade.

### The status ladder

| Status | Meaning | Shown to the client as |
|---|---|---|
| `WITHIN_RANGE` | Comfortably inside the range | Within range |
| `BORDERLINE_LOW` / `_HIGH` | Inside, but within 5 % of a boundary | Low / High end of range |
| `LOW` / `HIGH` | Outside the range | Below / Above range |
| `CRITICAL_LOW` / `_HIGH` | Beyond a documented action threshold | Well below / Well above range |
| `NOT_AVAILABLE` | No numeric value could be read | Not measured |

The word "critical" never reaches the client. A panic-level result is described as *well outside the
preferred range* and routed to a professional — the urgency lives in the action, not the adjective.

**The borderline band** is 5 % of the range's own span for a two-sided range (so potassium 3.5–5.1 gets a
narrow band and platelets 150–410 a wide one), or 5 % of the bound for a one-sided range. A lower bound
of zero produces no borderline band, because every healthy result would otherwise trip it.

### Status is a fact; concern is a judgement

Status describes only where a number sits relative to its range. Whether that is *unfavourable* depends
on the marker. An LDL below its range prints honestly as "Below range" and does **not** lower the
cardiovascular grade, because lower LDL is not a cardiovascular concern. The rule trace records each
such disregard explicitly.

---

## 4. Health areas and marker weights

Nine areas. Each marker carries a weight of 1–4 *within each area it belongs to* — a shared marker such
as triglycerides can be weight 3 in Cardiovascular and weight 2 in Metabolic.

| Area | Minimum set required to grade |
|---|---|
| Cardiovascular | (LDL **or** non-HDL **or** ApoB) **and** (HDL **or** triglycerides) |
| Metabolic & Blood Sugar | Fasting glucose **or** HbA1c |
| Liver | ALT **and** at least one of AST / ALP / GGT / bilirubin |
| Kidney | Creatinine **or** eGFR |
| Thyroid | TSH |
| Blood & Oxygen Transport | Haemoglobin **and** at least two of RBC / haematocrit / MCV / WBC / platelets |
| Vitamins & Minerals | Any two micronutrient markers |
| Inflammation & Immunity | hs-CRP **or** CRP **or** ESR |
| Body Composition | An actual BodyBank measurement — **never inferred from blood** |

Weight-4 (dominant) markers: LDL, non-HDL, ApoB, HbA1c, ALT, eGFR, TSH, haemoglobin, hs-CRP.
Weight-1 (contextual) markers: total cholesterol, VLDL, globulin, chloride, the WBC differential.

Any marker not in the registry — urinalysis, hormone panels, serology, an unrecognised name — appears in
the **Other Results** group of the detailed table with its full value and range. **Nothing is dropped.**

---

## 5. How a grade is computed

Four steps, applied in order. The final grade is the worst outcome of steps 2, 3 and 4.

### Step 1 — Sufficiency
Minimum set unmet → **Not Assessed**, with the missing tests named. Never a guess.

### Step 2 — Weighted accumulation, with a correlation guard

Each marker deviating in its unfavourable direction contributes `weight × severity`, where severity is
1 (borderline), 2 (outside range) or 3 (well outside range).

**Correlated markers contribute only their single highest value, never their sum.** This is the rule
that prevents one finding being counted three times. Total cholesterol is mostly LDL; haemoglobin,
haematocrit and RBC move together; AST rises with ALT; HbA1c and fasting glucose measure the same
glycaemia. The correlation groups are:

| Group | Members |
|---|---|
| Atherogenic lipids | Total cholesterol, LDL, non-HDL, ApoB |
| Triglyceride-carried | Triglycerides, VLDL |
| Red cell mass | Haemoglobin, haematocrit, RBC count |
| Red cell indices | MCV, MCH, MCHC |
| Transaminases | ALT, AST |
| Cholestatic enzymes | ALP, GGT |
| Bilirubin | Total, direct, indirect |
| Liver proteins | Albumin, total protein, globulin, A:G ratio |
| Renal filtration | Creatinine, eGFR, cystatin C |
| Renal nitrogen | Urea, BUN |
| Glycaemia | HbA1c, fasting glucose, post-prandial glucose |
| Insulin axis | Fasting insulin, HOMA-IR |
| Iron transport | Serum iron, TIBC, transferrin saturation |
| Inflammation | hs-CRP, CRP |

Score thresholds: **≥ 16 → D**, **≥ 8 → C**, **≥ 1 → B**, **0 → A**.

They are set so a *single* finding never reaches D on accumulation alone. Worked examples:

| Panel | Score | Accumulation grade |
|---|---|---|
| LDL borderline high | 4 × 1 = 4 | B |
| LDL 158 (range 0–100) | 4 × 2 = 8 | C |
| LDL high + total cholesterol high | 8 (same group — counted once) | C |
| Triglycerides high + HDL low | 6 + 6 = 12 | C |
| LDL high + triglycerides high + HDL low | 8 + 6 + 6 = 20 | D |
| HbA1c 6.1 + fasting glucose 112 | 8 (same group — counted once) | C |

### Step 3 — Severity ceiling

The worst single marker puts a floor under the grade, so a genuinely bad result cannot be averaged away
by a long panel of normal ones:

- any marker **well outside** its range → the area is **D**
- **outside range** on a weight-3 or weight-4 marker → at least **C**
- **outside range** on a weight-1 or weight-2 marker → at least **B**
- any **borderline** marker → at least **B**

### Step 4 — Pattern rules

Clinically recognised combinations that mean more together than apart. A pattern can only make a grade
worse, with one deliberate exception noted below.

| # | Pattern | Condition | Effect |
|---|---|---|---|
| P1 | Atherogenic lipid pattern | Triglycerides high **and** HDL low | Cardiovascular ≥ C |
| P2 | Metabolic cluster | P1 **and** (fasting glucose or HbA1c high) | Metabolic ≥ C |
| P3 | Iron-deficiency pattern | Haemoglobin low **and** MCV low **and** ferritin low, **and no inflammation** | Blood ≥ C, Nutritional ≥ C |
| P3b | Iron stores obscured | Inflammation present **and** ferritin measured | Nutritional ≥ B, with an explanatory note |
| P4 | Macrocytic pattern | Haemoglobin low **and** MCV high | Blood ≥ C |
| P4b | Macrocytic with low B12/folate | MCV high **and** (B12 or folate low) | Nutritional ≥ C |
| P5 | Hepatocellular pattern | ALT **and** AST both above range | Liver ≥ C |
| P5b | Markedly raised transaminase | ALT or AST > 3× upper limit | Liver = **D** |
| P6 | Cholestatic pattern | ALP **and** GGT both above range | Liver ≥ C |
| P7 | Reduced filtration | eGFR < 60 | Kidney ≥ C |
| P7b | Substantially reduced filtration | eGFR < 30 | Kidney = **D** |
| P8 | Isolated TSH change | TSH out of range, Free T4 in range | Thyroid ≥ B, **capped at C** |
| P9 | Diabetic range | HbA1c ≥ 6.5 % or fasting glucose ≥ 126 mg/dL | Metabolic = **D** |
| P10 | Pre-diabetic range | HbA1c 5.7–6.4 % or fasting glucose 100–125 mg/dL | Metabolic ≥ C |
| P11 | Insulin resistance | Fasting insulin above range or HOMA-IR ≥ 2.5 | Metabolic ≥ C |
| P12 | Sustained inflammation | hs-CRP, CRP or ESR above range | Inflammation ≥ C |
| P13 | Severe vitamin D deficiency | Vitamin D < 20 ng/mL | Nutritional ≥ C |

**Two rules deserve a clinician's attention:**

- **P3 stands down when inflammation is present.** Ferritin is an acute-phase reactant; inflammation can
  lift it into the normal range and mask genuine iron deficiency, or raise it on its own. Rather than
  assert or deny iron deficiency in that situation, the report says the iron stores cannot be read
  confidently from this panel and explains why.
- **P8 caps rather than floors.** A raised TSH with a normal Free T4 is the classic subclinical picture
  and does not, on its own, warrant the top tier of concern. The cap stands down if any marker in the
  area is at an action threshold.

### Auditability

Every grade emits an ordered trace of the rules that fired, for example:

```
SUFFICIENCY_MET: LDL or non-HDL cholesterol, together with HDL or triglycerides
SCORE LIPID_ATHEROGENIC: LDL_C=HIGH weight=4 severity=2 -> 8
SCORE LIPID_HDL: HDL_C=LOW weight=3 severity=2 -> 6
SCORE LIPID_TG: TRIGLYCERIDES=HIGH weight=3 severity=2 -> 6
CORRELATION_GUARD LIPID_ATHEROGENIC: 2 related markers counted once
ACCUMULATION: score=20 -> D
CEILING: C (already met)
PATTERN P1 (Atherogenic lipid pattern): floor C (already met)
FINAL=D
```

This trace is stored with the report and available to staff at
`GET /api/blood/admin/report/:id/graded-rationale`. It is deliberately not shown to clients raw.

**There is no overall 0–100 score.** The Health Map is the summary. A single score would have to
combine areas of different clinical weight, handle missing data invisibly, and blend health status with
lifestyle performance. It is logged as a backlog item and would need its own methodology.

---

## 6. Comparison against a previous screening

### Clinical significance is required

Every lab value moves between draws even when nothing about the person changed — analytical variation
in the assay plus biological variation within the individual. An engine that calls any downward movement
"Improved" will tell a client their cholesterol improved when it did not.

So each marker declares a significance threshold, and **a change must clear every defined bar** before
it is called anything but noise. This is more conservative than requiring either bar: BodyBank will
occasionally under-claim a real improvement rather than routinely over-claim one.

| Marker | Threshold |
|---|---|
| LDL, non-HDL, ApoB | ≥ 10 mg/dL **and** ≥ 10 % |
| Total cholesterol | ≥ 15 mg/dL **and** ≥ 10 % |
| HDL | ≥ 5 mg/dL |
| Triglycerides | ≥ 30 mg/dL **and** ≥ 20 % |
| HbA1c | ≥ 0.3 % |
| Fasting glucose | ≥ 10 mg/dL |
| Fasting insulin | ≥ 2 µIU/mL **and** ≥ 20 % |
| ALT, AST, GGT | ≥ 10 U/L **and** ≥ 25 % |
| eGFR | ≥ 5 mL/min/1.73m² |
| Creatinine | ≥ 0.2 mg/dL |
| TSH | ≥ 0.5 µIU/mL |
| Vitamin D | ≥ 5 ng/mL |
| Vitamin B12 | ≥ 50 pg/mL **and** ≥ 20 % |
| Ferritin | ≥ 20 ng/mL **and** ≥ 25 % |
| Haemoglobin | ≥ 0.5 g/dL |
| Platelets | ≥ 30 ×10³/µL **and** ≥ 20 % |
| hs-CRP | ≥ 1.0 mg/L **and** ≥ 50 % |
| *(not listed)* | ≥ 10 % of the previous value |

Worked example: LDL 200 → 190 mg/dL clears the absolute bar but is only a 5 % move, inside normal
variation, and is reported as *No Significant Change* — not as an improvement.

### Trend vocabulary (fixed)

| Trend | Condition |
|---|---|
| **Improved** | Clears the threshold in the favourable direction |
| **Needs Attention** | Clears the threshold in the unfavourable direction |
| **Stable** | Below threshold, status unchanged |
| **No Significant Change** | Below threshold, but the status label moved (a boundary crossing on a small move) |
| **New Finding** | Was in range and is not now, **or** newly measured and outside range — the report says which |
| **Resolved** | Was outside range and is now within it |
| **No comparison available** | No previous value, or units that cannot be reconciled |

### Direction and units

Favourable direction is declared per marker: lower is better for LDL, higher for HDL, and in-range for
TSH. Range-type markers are judged by whether they moved *toward* their range.

Units are converted only when recognised. An unrecognised unit yields *No comparison available* rather
than a guessed conversion. **Urea and BUN are kept as separate markers and never converted between**
(Urea ≈ BUN × 2.14), because labs print them under confusingly similar names.

### Area trends

An area's trend is its grade delta, plus the single marker whose weighted contribution changed most —
the same quantity the grade was built from, so the named driver always explains the grade rather than
merely correlating with it.

Because a grade is a coarse instrument, each area card also reports what actually moved. An LDL that
fell 24 mg/dL inside an area that stayed at D produces: *"This area is unchanged at D since your last
screening. LDL Cholesterol improved."* Reporting only the grade delta would tell that client their work
achieved nothing.

**No previous report means no trends.** Nothing is inferred, and the report says *"First screening —
trends will appear on your next report."* Screenings less than 28 days apart carry a short-interval
caution.

---

## 7. Priorities

At most three, chosen in this order:

1. Anything in an area graded **D** — a result needing a professional outranks one needing a diet change
2. Severity tier
3. Clinical weight within its area
4. An unfavourable trend since the last screening
5. Actionability — a finding with a clear lifestyle lever
6. Canonical marker ID, ascending, as a deterministic tie-break

Two constraints:

- **No two priorities from one correlation group.** Total cholesterol and LDL would otherwise take two
  slots to say the same thing.
- **A soft cap of two per health area.** One bad lipid panel should not take all three slots and leave a
  low ferritin unmentioned. The cap lifts if there is nothing else to promote.

The section is **never padded**. One qualifying finding produces one card.

Each card shows: title · why it matters · your result · status · grade · next step. A grade-D card also
carries "Discuss this result with your healthcare professional" **alongside** the next step, not instead
of it — a client waiting two weeks for an appointment still needs something to do.

---

## 8. Report structure

1. **Results to review first** — only when a marker is at an action threshold; sits above everything
2. **Health Map** — the grade grid, page-one hero, no marker values
3. **Key message** — one neutral framing sentence
4. **Top Priorities** — up to three, opens page two in print
5. **Your Health Progress** — improved / needs attention / new / resolved / stable
6. **Health Areas** — one card per area, ordered D → C → B → A
7. **Detailed Lab Results** — every marker, grouped by area, Other Results last
8. **Your Next Steps** — three to five actions
9. **A note from your coach** — free text, synced with the report's admin note
10. **Medical disclaimer** — always present, never collapsed

Every marker row and area card separates four layers with fixed labels: **RESULT · STATUS · BODYBANK
INSIGHT · NEXT STEP**. A measured number and an interpretation of that number must never be mistakable
for one another.

### Colour

Four muted tones, separated by lightness as well as hue, plus a neutral. Not a traffic light: a D is not
a failure, it is an appointment. Every grade is drawn with its letter, its label **and** a four-segment
severity bar, so the report reads correctly in greyscale and to a colour-blind reader.

---

## 9. Editorial control

A coach or doctor reviews every report before it is sent. They can hide, retitle, reorder and rewrite
any section, and drop individual findings or markers.

**Two things they cannot edit:**

- **The RESULT layer** — measured values, units and reference ranges. These are what the lab printed.
- **The STATUS layer** — the derived classification, which follows from the value and the range by
  arithmetic.

A reviewer who disagrees with a grade hides the section or writes a note beside it, which keeps the
disagreement visible rather than silently rewriting the evidence.

The **disclaimer cannot be removed, hidden, or reduced below 60 characters** by any editing path. A
genuine legal rewrite is accepted; gutting it is not.

The editor's preview renders the same document the PDF renders, through the same character
transliteration, so what a reviewer approves is what the client receives.

---

## 10. What a clinician should review before this ships

1. **The marker weights in §4.** Is LDL the right weight-4 anchor for cardiovascular? Should ferritin
   outrank vitamin D in Nutritional?
2. **The pattern rules in §5**, especially P3's inflammation stand-down and P8's cap.
3. **The action thresholds** behind `CRITICAL_*` — potassium < 2.5 or > 6.5 mmol/L, haemoglobin < 7 g/dL,
   platelets < 50 ×10³/µL, eGFR < 30, ALT/AST > 500 U/L, TSH < 0.1 or > 10 µIU/mL, LDL > 190 mg/dL,
   triglycerides > 500 mg/dL, calcium < 7.0 or > 13.0 mg/dL, sodium < 120 or > 160 mmol/L.
4. **The BodyBank preferred ranges** used when a lab prints none, listed in
   `services/grading/markerRegistry.js` under each marker's `preferred` field.
5. **The significance thresholds in §6**, and the decision to require every bar rather than any bar.
6. **The grade labels** — *Healthy / Monitor / Attention Recommended / Further Evaluation* — and whether
   they carry the right weight for an Indian client population.

---

## 11. Known limitations

- **Indian lab panels frequently omit** hs-CRP, ApoB, Lp(a), Free T3/T4 and fasting insulin. Those areas
  will often read *Not Assessed*. This is correct behaviour, and the report turns each gap into a
  concrete next step by naming the test that would unlock the area.
- **Sex-specific ranges** are applied where BodyBank holds them (HDL, haemoglobin, haematocrit, RBC,
  ferritin, creatinine, uric acid, ESR) and depend on the sex recorded at upload. A lab's own printed
  range always takes precedence and is usually already sex-adjusted.
- **Age-specific ranges are not modelled.** The lab's printed range carries this where the lab provides it.
- **Body Composition is never gradeable from a blood panel** and will always report as not assessed on a
  blood-only screening.
- **Pregnancy, dialysis, active malignancy and similar contexts are not modelled.** The report is a
  presentation of results for a general adult wellness population; anything at grade D routes to a
  professional precisely because the system cannot know the clinical context.
