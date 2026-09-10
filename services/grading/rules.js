'use strict';

/**
 * BodyBank — GRADING RULE SET.
 *
 * Everything that decides a grade lives here as data, so the rules can be read,
 * reviewed by a clinician and tested one at a time. services/grading/index.js is
 * only the machinery that applies them.
 *
 * ─── FOUR KINDS OF RULE, APPLIED IN THIS ORDER ────────────────────────────────
 *
 *  1. SUFFICIENCY   Can this area be graded at all? Each area declares a minimum
 *                   marker set. If it is not met the area is NOT_ASSESSED and the
 *                   report names the missing tests. We never grade on a guess.
 *
 *  2. ACCUMULATION  A weighted score over the area's markers. Weight comes from the
 *                   registry, severity from the classifier, and — critically —
 *                   markers sharing a correlation group contribute only their
 *                   single highest value, never their sum. See index.js.
 *
 *  3. CEILINGS      A severity floor on the grade, independent of the score, so one
 *                   genuinely bad marker cannot be averaged away by good ones.
 *
 *  4. PATTERNS      Clinically recognised combinations that mean more together than
 *                   apart. A pattern can only make a grade WORSE, never better.
 *
 * The final grade is the worst outcome of 2, 3 and 4. Every rule that fires appends
 * a line to `gradeRationale`, so any grade can be replayed and explained months later.
 *
 * ─── DIRECTION ────────────────────────────────────────────────────────────────
 * Only deviations in the UNFAVOURABLE direction count toward a grade. An LDL below
 * its reference range still prints as "Below range" in the table — because that is
 * the fact — but it does not push the cardiovascular grade down, because lower LDL
 * is not a cardiovascular concern. Markers whose registry direction is RANGE count
 * deviations on both sides.
 */

const { SEVERITY } = require('./classify');

/** Ruleset stamp persisted with every generated report (brief §12.2). */
const RULESET_VERSION = 'bb-health-areas@2026-09-1';

const GRADES = ['A', 'B', 'C', 'D'];
const GRADE_LABEL = {
  A: 'Healthy',
  B: 'Monitor',
  C: 'Attention Recommended',
  D: 'Further Evaluation',
  NOT_ASSESSED: 'Not Assessed'
};
const GRADE_MEANING = {
  A: 'All measured markers in this area sit within their preferred range.',
  B: 'A mild or borderline reading worth tracking on your next screening.',
  C: 'A meaningful result in this area that focused lifestyle action can improve.',
  D: 'A result that should be reviewed with a healthcare professional.',
  NOT_ASSESSED: 'This screening did not include enough tests to assess this area responsibly.'
};

/** Rank: higher is worse. Used to take "the worst of" several rule outcomes. */
function rank(grade) {
  const i = GRADES.indexOf(grade);
  return i < 0 ? -1 : i;
}
/** The worse of two grades. */
function worst(a, b) {
  if (!a) return b;
  if (!b) return a;
  return rank(a) >= rank(b) ? a : b;
}

// ---------------------------------------------------------------------------
// 1. Sufficiency
// ---------------------------------------------------------------------------
//
// Clause shapes:
//   { anyOf: [ids] }             at least one of these must be present
//   { atLeast: n, of: [ids] }    at least n of these must be present
//
// `describe` is the sentence shown to the client when the area cannot be graded.

const SUFFICIENCY = {
  CARDIOVASCULAR: {
    describe: 'LDL or non-HDL cholesterol, together with HDL or triglycerides',
    all: [
      { anyOf: ['LDL_C', 'NON_HDL_C', 'APO_B'] },
      { anyOf: ['HDL_C', 'TRIGLYCERIDES'] }
    ]
  },
  METABOLIC: {
    describe: 'fasting glucose or HbA1c',
    all: [{ anyOf: ['FASTING_GLUCOSE', 'HBA1C'] }]
  },
  LIVER: {
    describe: 'ALT, together with at least one of AST, ALP, GGT or bilirubin',
    all: [
      { anyOf: ['ALT'] },
      { anyOf: ['AST', 'ALP', 'GGT', 'BILIRUBIN_TOTAL'] }
    ]
  },
  KIDNEY: {
    describe: 'creatinine or eGFR',
    all: [{ anyOf: ['CREATININE', 'EGFR'] }]
  },
  THYROID: {
    describe: 'TSH',
    all: [{ anyOf: ['TSH'] }]
  },
  BLOOD: {
    describe: 'haemoglobin, together with at least two of RBC count, haematocrit, MCV, WBC or platelets',
    all: [
      { anyOf: ['HEMOGLOBIN'] },
      { atLeast: 2, of: ['RBC', 'HEMATOCRIT', 'MCV', 'WBC', 'PLATELETS'] }
    ]
  },
  NUTRITIONAL: {
    describe: 'any two vitamin or mineral markers',
    all: [
      {
        atLeast: 2,
        of: ['VITAMIN_D', 'VITAMIN_B12', 'FOLATE', 'FERRITIN', 'SERUM_IRON', 'TIBC',
          'TRANSFERRIN_SAT', 'CALCIUM', 'MAGNESIUM', 'ZINC', 'PHOSPHORUS']
      }
    ]
  },
  INFLAMMATION: {
    describe: 'hs-CRP or ESR',
    all: [{ anyOf: ['HS_CRP', 'CRP', 'ESR'] }]
  },
  BODY_COMPOSITION: {
    // Never inferred from blood. Satisfied only by a real BodyBank measurement,
    // which the blood pipeline does not carry — so this area reports as not
    // assessed on a blood-only screening, by design.
    describe: 'a BodyBank body-composition measurement',
    all: [{ anyOf: ['__BODY_COMPOSITION_MEASUREMENT__'] }]
  }
};

/**
 * Evaluate an area's sufficiency.
 * @param {string} areaId
 * @param {Set<string>} presentIds gradable marker ids present in this report
 * @returns {{ met:boolean, describe:string, missing:string[] }}
 *          `missing` lists the ids of the clauses that were not satisfied.
 */
function checkSufficiency(areaId, presentIds) {
  const spec = SUFFICIENCY[areaId];
  if (!spec) return { met: false, describe: '', missing: [] };
  const missing = [];
  let met = true;

  (spec.all || []).forEach((clause) => {
    if (clause.anyOf) {
      const found = clause.anyOf.some((id) => presentIds.has(id));
      if (!found) {
        met = false;
        missing.push.apply(missing, clause.anyOf);
      }
      return;
    }
    if (clause.of) {
      const have = clause.of.filter((id) => presentIds.has(id));
      if (have.length < (clause.atLeast || 1)) {
        met = false;
        missing.push.apply(missing, clause.of.filter((id) => !presentIds.has(id)));
      }
    }
  });

  return { met, describe: spec.describe, missing };
}

// ---------------------------------------------------------------------------
// 2. Accumulation thresholds
// ---------------------------------------------------------------------------
//
// The score is the sum, across correlation groups, of (weight × severity tier)
// for markers deviating in the unfavourable direction. Severity tiers are
// borderline = 1, abnormal = 2, critical = 3.
//
// Thresholds are deliberately set so that a SINGLE finding never reaches D on
// accumulation alone — D on accumulation requires a genuine cluster. Worked
// examples (weights from the registry):
//
//   LDL borderline           4 × 1 =  4  → B
//   LDL high                 4 × 2 =  8  → C
//   TG high + HDL low        6 + 6 = 12  → C   (also pattern P1)
//   LDL high + TG high + HDL low  8+6+6 = 20  → D
//   Total chol high alone, LDL normal:  TC shares LIPID_ATHEROGENIC with LDL,
//     so the group contributes max(0, 1×2) = 2 → B, not a second C.
//
const ACCUMULATION = [
  { atLeast: 16, grade: 'D' },
  { atLeast: 8, grade: 'C' },
  { atLeast: 1, grade: 'B' },
  { atLeast: 0, grade: 'A' }
];

function accumulationGrade(score) {
  for (let i = 0; i < ACCUMULATION.length; i += 1) {
    if (score >= ACCUMULATION[i].atLeast) return ACCUMULATION[i].grade;
  }
  return 'A';
}

// ---------------------------------------------------------------------------
// 3. Severity ceilings
// ---------------------------------------------------------------------------

/**
 * The floor a single marker's severity puts under the area grade.
 * @param {number} severity SEVERITY tier
 * @param {number} weight   registry weight of the marker within this area
 * @returns {string|null} grade floor, or null when the marker imposes none
 */
function ceilingFor(severity, weight) {
  if (severity >= SEVERITY.CRITICAL) return 'D';
  if (severity >= SEVERITY.ABNORMAL) return weight >= 3 ? 'C' : 'B';
  if (severity >= SEVERITY.BORDERLINE) return 'B';
  return null;
}

// ---------------------------------------------------------------------------
// 4. Pattern rules
// ---------------------------------------------------------------------------
//
// Each rule receives a context `q` with helpers over this report's markers:
//   q.has(id)            marker present and gradable
//   q.high(id)           deviating above range (any severity)
//   q.low(id)            deviating below range (any severity)
//   q.abnormalHigh(id)   above range at ABNORMAL or CRITICAL (not merely borderline)
//   q.abnormalLow(id)
//   q.value(id)          canonical-unit value, or null when the unit was unknown
//   q.overUpperBy(id, x) value exceeds its upper reference bound by a factor of x
//
// `atLeast` is a FLOOR: the pattern can only make a grade worse.

const PATTERNS = [
  {
    id: 'P1',
    name: 'Atherogenic lipid pattern',
    areas: ['CARDIOVASCULAR'],
    atLeast: 'C',
    rationale: 'Raised triglycerides together with low HDL — a combination that matters more than either result on its own.',
    when: (q) => q.high('TRIGLYCERIDES') && q.low('HDL_C')
  },
  {
    id: 'P2',
    name: 'Metabolic cluster',
    areas: ['METABOLIC'],
    atLeast: 'C',
    rationale: 'Raised triglycerides, low HDL and a raised blood-sugar marker occurring together.',
    when: (q) => q.high('TRIGLYCERIDES') && q.low('HDL_C') &&
      (q.high('FASTING_GLUCOSE') || q.high('HBA1C'))
  },
  {
    id: 'P3',
    name: 'Iron-deficiency pattern',
    areas: ['BLOOD', 'NUTRITIONAL'],
    atLeast: 'C',
    rationale: 'Low haemoglobin with small red cells and low iron stores — a recognised iron-deficiency picture.',
    // Ferritin is an acute-phase reactant: active inflammation can lift it into the
    // normal range and mask genuine iron deficiency, and can also raise it on its
    // own. When inflammation is present this rule stands down and P3b speaks instead.
    when: (q) => q.low('HEMOGLOBIN') && q.low('MCV') && q.low('FERRITIN') &&
      !(q.high('HS_CRP') || q.high('CRP') || q.high('ESR'))
  },
  {
    id: 'P3b',
    name: 'Iron stores obscured by inflammation',
    areas: ['NUTRITIONAL'],
    atLeast: 'B',
    rationale: 'Inflammation is present, and inflammation can lift ferritin — so iron stores cannot be read confidently from this panel.',
    when: (q) => (q.high('HS_CRP') || q.high('CRP') || q.high('ESR')) && q.has('FERRITIN')
  },
  {
    id: 'P4',
    name: 'Macrocytic pattern',
    areas: ['BLOOD'],
    atLeast: 'C',
    rationale: 'Low haemoglobin with enlarged red cells, a pattern often linked to B12 or folate status.',
    when: (q) => q.low('HEMOGLOBIN') && q.high('MCV')
  },
  {
    id: 'P4b',
    name: 'Macrocytic pattern with low B12 or folate',
    areas: ['NUTRITIONAL'],
    atLeast: 'C',
    rationale: 'Enlarged red cells alongside a low B12 or folate result.',
    when: (q) => q.high('MCV') && (q.low('VITAMIN_B12') || q.low('FOLATE'))
  },
  {
    id: 'P5',
    name: 'Hepatocellular pattern',
    areas: ['LIVER'],
    atLeast: 'C',
    rationale: 'Both liver transaminases are raised together.',
    when: (q) => q.abnormalHigh('ALT') && q.abnormalHigh('AST')
  },
  {
    id: 'P5b',
    name: 'Markedly raised transaminases',
    areas: ['LIVER'],
    atLeast: 'D',
    rationale: 'A liver enzyme is more than three times its upper reference limit.',
    when: (q) => q.overUpperBy('ALT', 3) || q.overUpperBy('AST', 3)
  },
  {
    id: 'P6',
    name: 'Cholestatic pattern',
    areas: ['LIVER'],
    atLeast: 'C',
    rationale: 'ALP and GGT are raised together, a pattern associated with bile flow rather than liver cells.',
    when: (q) => q.abnormalHigh('ALP') && q.abnormalHigh('GGT')
  },
  {
    id: 'P7',
    name: 'Reduced filtration',
    areas: ['KIDNEY'],
    atLeast: 'C',
    rationale: 'Estimated filtration rate is below 60 mL/min/1.73m².',
    when: (q) => { const v = q.value('EGFR'); return v != null && v < 60; }
  },
  {
    id: 'P7b',
    name: 'Substantially reduced filtration',
    areas: ['KIDNEY'],
    atLeast: 'D',
    rationale: 'Estimated filtration rate is below 30 mL/min/1.73m².',
    when: (q) => { const v = q.value('EGFR'); return v != null && v < 30; }
  },
  {
    id: 'P8',
    name: 'Isolated TSH change',
    areas: ['THYROID'],
    atLeast: 'B',
    // A cap, not a floor — see index.js. TSH out of range with a normal Free T4 is
    // the classic subclinical picture, and on its own it does not warrant more than
    // "Attention Recommended".
    cap: 'C',
    rationale: 'TSH is outside its range while Free T4 sits within range.',
    when: (q) => (q.high('TSH') || q.low('TSH')) && q.has('FREE_T4') &&
      !q.high('FREE_T4') && !q.low('FREE_T4')
  },
  {
    id: 'P9',
    name: 'Blood sugar in the diabetic range',
    areas: ['METABOLIC'],
    atLeast: 'D',
    rationale: 'A blood-sugar marker is at or above the threshold used to define diabetes.',
    when: (q) => {
      const a1c = q.value('HBA1C');
      const glu = q.value('FASTING_GLUCOSE');
      return (a1c != null && a1c >= 6.5) || (glu != null && glu >= 126);
    }
  },
  {
    id: 'P10',
    name: 'Blood sugar in the pre-diabetic range',
    areas: ['METABOLIC'],
    atLeast: 'C',
    rationale: 'A blood-sugar marker sits in the range described as pre-diabetes.',
    when: (q) => {
      const a1c = q.value('HBA1C');
      const glu = q.value('FASTING_GLUCOSE');
      return (a1c != null && a1c >= 5.7 && a1c < 6.5) ||
        (glu != null && glu >= 100 && glu < 126);
    }
  },
  {
    id: 'P11',
    name: 'Insulin resistance pattern',
    areas: ['METABOLIC'],
    atLeast: 'C',
    rationale: 'Fasting insulin or HOMA-IR is raised, which can precede a change in blood sugar.',
    when: (q) => q.abnormalHigh('FASTING_INSULIN') || (() => {
      const h = q.value('HOMA_IR');
      return h != null && h >= 2.5;
    })()
  },
  {
    id: 'P12',
    name: 'Sustained inflammation',
    areas: ['INFLAMMATION'],
    atLeast: 'C',
    rationale: 'An inflammatory marker is raised. These markers also rise with a recent infection or injury.',
    when: (q) => q.abnormalHigh('HS_CRP') || q.abnormalHigh('CRP') || q.abnormalHigh('ESR')
  },
  {
    id: 'P13',
    name: 'Severe vitamin D deficiency',
    areas: ['NUTRITIONAL'],
    atLeast: 'C',
    rationale: 'Vitamin D is well below the preferred range.',
    when: (q) => { const v = q.value('VITAMIN_D'); return v != null && v < 20; }
  }
];

module.exports = {
  RULESET_VERSION,
  GRADES,
  GRADE_LABEL,
  GRADE_MEANING,
  SUFFICIENCY,
  ACCUMULATION,
  PATTERNS,
  rank,
  worst,
  checkSufficiency,
  accumulationGrade,
  ceilingFor
};
