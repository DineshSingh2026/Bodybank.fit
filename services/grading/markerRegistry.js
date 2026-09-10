'use strict';

/**
 * BodyBank — CANONICAL MARKER REGISTRY.
 *
 * The single source of truth for "what is this lab marker, and what does BodyBank
 * know about it". Every other module in services/grading, services/comparison and
 * services/priority reads this file and nothing else. Nothing here performs I/O,
 * calls an API, reads a clock or mutates state.
 *
 * ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * A lab report is a pile of strings. "SGPT", "ALT (SGPT)", "Alanine Transaminase"
 * and "Alanine aminotransferase (ALT)" are the same test. Until they collapse to
 * one canonical id, a grading engine will double-count one marker and miss another.
 *
 * ─── THE FOUR THINGS EVERY ENTRY DECLARES ─────────────────────────────────────
 *  1. IDENTITY   id + display + aliases      → which test is this, really
 *  2. PLACEMENT  areas{}                     → which health area(s), at what weight
 *  3. DIRECTION  direction + preferred       → which way is good, and by whose range
 *  4. SAFETY     units + critical + group    → how not to be wrong
 *
 * ─── THE CORRELATION GROUP: HOW OVERLAP IS PREVENTED ──────────────────────────
 * Total Cholesterol and LDL are not two independent pieces of evidence — TC is
 * mostly LDL. Hemoglobin, Hematocrit and RBC move together. AST and ALT rise
 * together. If each contributed its own weight, one abnormality would be counted
 * three times and a single mildly-raised lipid panel would grade worse than a
 * genuinely abnormal one.
 *
 * So every marker declares a `group`. Inside a health area, all markers sharing a
 * group contribute only their SINGLE HIGHEST weighted deviation — never the sum.
 * A marker with a unique group is its own group of one. See services/grading/index.js
 * `weightedAreaScore()`, and the "double counting" tests in tests/grading-engine.js.
 *
 * ─── UNITS: CONVERT ONLY WHEN CERTAIN ─────────────────────────────────────────
 * Status classification needs NO conversion — the lab prints the value and its
 * reference range in the same unit, so they compare directly. Conversion is needed
 * only to (a) apply a BodyBank preferred range or a critical threshold, and
 * (b) compare this report against a previous one.
 *
 * `units` maps a normalised unit string to a multiplier onto the canonical unit.
 * A unit that is absent from the map is NOT guessed: the preferred range and the
 * critical check are skipped, and a cross-report comparison returns NOT_COMPARABLE.
 * Urea and BUN are deliberately kept as two separate markers rather than converted
 * (Urea ≈ BUN × 2.14) because labs print both under confusingly similar names.
 *
 * ─── PROVENANCE ───────────────────────────────────────────────────────────────
 * Preferred ranges and critical thresholds are conventional adult clinical values
 * and are documented, one line each, in docs/health-report-redesign/METHODOLOGY.md
 * for clinical review. They are a BodyBank framework, not a diagnosis, and the UI
 * labels every one of them as "BodyBank preferred range". A range printed by the
 * lab always wins for status.
 */

const { normalizeMarkerName } = require('../bloodComparisonService');

/** Ruleset stamp persisted with every generated report (brief §12.2). */
const REGISTRY_VERSION = 'bb-markers@2026-09-1';

/** The nine health areas. Order here is the canonical display order. */
const AREAS = {
  CARDIOVASCULAR: {
    id: 'CARDIOVASCULAR',
    label: 'Cardiovascular',
    blurb: 'Cholesterol and other markers linked to heart and blood-vessel health.',
    focusDefault:
      'Regular aerobic activity, more soluble fibre (oats, beans, apples), and less saturated fat and fried food support these markers.'
  },
  METABOLIC: {
    id: 'METABOLIC',
    label: 'Metabolic & Blood Sugar',
    blurb: 'How the body handles sugar and stores energy.',
    focusDefault:
      'Walking after meals, lower refined-carbohydrate intake, resistance training and steady sleep all move these markers.'
  },
  LIVER: {
    id: 'LIVER',
    label: 'Liver',
    blurb: 'Enzymes and proteins that reflect how the liver is working.',
    focusDefault:
      'Reducing alcohol, added sugar and ultra-processed food, and losing excess weight gradually, are the strongest levers here.'
  },
  KIDNEY: {
    id: 'KIDNEY',
    label: 'Kidney',
    blurb: 'Filtration markers and the salts the kidneys balance.',
    focusDefault:
      'Steady hydration, moderate protein and salt, and keeping blood pressure and blood sugar in range protect kidney function.'
  },
  THYROID: {
    id: 'THYROID',
    label: 'Thyroid',
    blurb: 'The hormones that set metabolic rate.',
    focusDefault:
      'Adequate iodine and selenium, consistent sleep, and managed stress support thyroid function. Medication changes are a doctor decision.'
  },
  BLOOD: {
    id: 'BLOOD',
    label: 'Blood & Oxygen Transport',
    blurb: 'Red cells, white cells and platelets.',
    focusDefault:
      'Iron-rich foods with vitamin C, adequate B12 and folate, and treating any source of blood loss are the usual levers.'
  },
  NUTRITIONAL: {
    id: 'NUTRITIONAL',
    label: 'Vitamins & Minerals',
    blurb: 'Micronutrient stores measured on this panel.',
    focusDefault:
      'Sunlight and food sources first, targeted supplementation second, and a retest to confirm the change.'
  },
  INFLAMMATION: {
    id: 'INFLAMMATION',
    label: 'Inflammation & Immunity',
    blurb: 'General markers of inflammation in the body.',
    focusDefault:
      'Sleep, oily fish or omega-3, more vegetables, less ultra-processed food, and treating any active infection.'
  },
  BODY_COMPOSITION: {
    id: 'BODY_COMPOSITION',
    label: 'Body Composition',
    blurb: 'Measured body composition — never inferred from blood markers.',
    focusDefault:
      'Progressive resistance training with adequate protein preserves lean mass while body fat reduces.'
  }
};

const AREA_ORDER = [
  'CARDIOVASCULAR', 'METABOLIC', 'LIVER', 'KIDNEY', 'THYROID',
  'BLOOD', 'NUTRITIONAL', 'INFLAMMATION', 'BODY_COMPOSITION'
];

// ---------------------------------------------------------------------------
// Unit conversion tables
// ---------------------------------------------------------------------------

/** Normalise a printed unit for lookup: "mg / dL" -> "mg/dl", "µIU/mL" -> "uiu/ml". */
function normalizeUnit(u) {
  return String(u == null ? '' : u)
    .toLowerCase()
    .replace(/µ|μ/g, 'u')
    // Superscript digits: labs print "mL/min/1.73m²" and "µm³". Without this the
    // unit never matches its own map entry, and eGFR silently loses its preferred
    // range and its critical bound.
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/\s+/g, '')
    .replace(/^\(|\)$/g, '')
    .replace(/per/g, '/')
    .replace(/cumm|cu\.mm|cmm/g, '/ul')
    .replace(/10\^?3|10e3|x103/g, 'k')
    .replace(/10\^?9|10e9/g, 'k')      // 10^9/L is numerically identical to 10^3/uL
    .replace(/10\^?6|10e6/g, 'm')
    .replace(/10\^?12|10e12/g, 'm')    // 10^12/L is numerically identical to 10^6/uL
    .replace(/[\s,]/g, '');
}

// Reusable unit maps. Value = multiplier that converts INTO the canonical unit.
const U_CHOL = { 'mg/dl': 1, 'mgs/dl': 1, 'mg/100ml': 1, 'mmol/l': 38.67 };
const U_TRIG = { 'mg/dl': 1, 'mgs/dl': 1, 'mmol/l': 88.57 };
const U_GLUC = { 'mg/dl': 1, 'mgs/dl': 1, 'mmol/l': 18.016 };
const U_CREAT = { 'mg/dl': 1, 'mgs/dl': 1, 'umol/l': 1 / 88.4 };
const U_BILI = { 'mg/dl': 1, 'mgs/dl': 1, 'umol/l': 1 / 17.1 };
const U_CALC = { 'mg/dl': 1, 'mgs/dl': 1, 'mmol/l': 4.008 };
const U_MAG = { 'mg/dl': 1, 'mgs/dl': 1, 'mmol/l': 2.43, 'meq/l': 1.215 };
const U_IRON = { 'ug/dl': 1, 'mcg/dl': 1, 'umol/l': 5.587 };
const U_URIC = { 'mg/dl': 1, 'mgs/dl': 1, 'umol/l': 1 / 59.48 };
const U_GDL = { 'g/dl': 1, 'gm/dl': 1, 'gms/dl': 1, 'g/l': 0.1 };
const U_ENZ = { 'u/l': 1, 'iu/l': 1, 'units/l': 1, 'ukat/l': 60 };
const U_PCT = { '%': 1, 'percent': 1, '': 1 };
const U_KCELL = { 'k/ul': 1, '/ul': 0.001, 'k/l': 1, 'cells/ul': 0.001, 'k/cumm': 1 };
const U_MCELL = { 'm/ul': 1, '/ul': 0.000001, 'm/l': 1, 'mill/ul': 1, 'million/ul': 1 };
const U_VITD = { 'ng/ml': 1, 'ug/l': 1, 'mcg/l': 1, 'nmol/l': 1 / 2.496 };
const U_B12 = { 'pg/ml': 1, 'ng/l': 1, 'pmol/l': 1 / 0.7378 };
const U_FOLATE = { 'ng/ml': 1, 'ug/l': 1, 'nmol/l': 1 / 2.266 };
const U_FERR = { 'ng/ml': 1, 'ug/l': 1, 'mcg/l': 1 };
const U_CRP = { 'mg/l': 1, 'mg/dl': 10 };
const U_MMOL = { 'mmol/l': 1, 'meq/l': 1 };
const U_TSH = { 'uiu/ml': 1, 'miu/l': 1, 'uu/ml': 1, 'miu/ml': 1000 };
const U_FT4 = { 'ng/dl': 1, 'pmol/l': 1 / 12.87, 'ug/dl': 100 };
const U_FT3 = { 'pg/ml': 1, 'pmol/l': 1 / 1.536, 'ng/dl': 10 };
const U_INSULIN = { 'uiu/ml': 1, 'miu/l': 1, 'uu/ml': 1, 'pmol/l': 1 / 6.945 };

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------
//
// Entry shape:
//   id        canonical id, SCREAMING_SNAKE, stable forever (persisted in reports)
//   display   client-facing name
//   aliases   raw strings seen on lab reports; matched after normalizeMarkerName()
//   unit      canonical unit for preferred/critical thresholds
//   units     normalisedUnit -> multiplier into `unit`; missing = do not convert
//   areas     { AREA_ID: weight 1..4 }
//   direction 'LOWER' | 'HIGHER' | 'RANGE' — which way is favourable
//   group     correlation group; markers sharing one never stack inside an area
//   preferred BodyBank preferred range { low?, high? } or { male:{}, female:{} }
//   critical  panic-value bounds { low?, high? } in the canonical unit
//   sig       clinical-significance threshold for comparison { abs?, pct? }
//   decimals  display precision
//   note      shown under the marker when present
//
const MARKERS = [
  // ══════════════════════════════ CARDIOVASCULAR ══════════════════════════════
  {
    id: 'LDL_C', display: 'LDL Cholesterol', unit: 'mg/dL', units: U_CHOL,
    aliases: ['ldl', 'ldl cholesterol', 'ldl c', 'ldl cholesterol direct', 'cholesterol ldl',
      'low density lipoprotein', 'low density lipoprotein cholesterol', 'ldl calculated', 'serum ldl'],
    areas: { CARDIOVASCULAR: 4 }, direction: 'LOWER', group: 'LIPID_ATHEROGENIC',
    preferred: { high: 100 }, critical: { high: 190 }, sig: { abs: 10, pct: 10 }, decimals: 0
  },
  {
    id: 'NON_HDL_C', display: 'Non-HDL Cholesterol', unit: 'mg/dL', units: U_CHOL,
    aliases: ['non hdl cholesterol', 'non hdl', 'non hdl c', 'cholesterol non hdl'],
    areas: { CARDIOVASCULAR: 4 }, direction: 'LOWER', group: 'LIPID_ATHEROGENIC',
    preferred: { high: 130 }, critical: { high: 220 }, sig: { abs: 10, pct: 10 }, decimals: 0
  },
  {
    id: 'APO_B', display: 'Apolipoprotein B', unit: 'mg/dL', units: { 'mg/dl': 1, 'g/l': 100 },
    aliases: ['apo b', 'apob', 'apolipoprotein b', 'apolipoprotein b100', 'apo b 100'],
    areas: { CARDIOVASCULAR: 4 }, direction: 'LOWER', group: 'LIPID_ATHEROGENIC',
    preferred: { high: 90 }, critical: { high: 150 }, sig: { abs: 10, pct: 10 }, decimals: 0
  },
  {
    id: 'LP_A', display: 'Lipoprotein(a)', unit: 'nmol/L', units: { 'nmol/l': 1 },
    aliases: ['lp a', 'lpa', 'lipoprotein a', 'lipoprotein little a'],
    areas: { CARDIOVASCULAR: 3 }, direction: 'LOWER', group: 'LIPID_LPA',
    preferred: { high: 75 }, sig: { pct: 25 }, decimals: 0,
    note: 'Largely inherited. Labs report this in either nmol/L or mg/dL; BodyBank compares it only against a range printed in the same unit.'
  },
  {
    id: 'TRIGLYCERIDES', display: 'Triglycerides', unit: 'mg/dL', units: U_TRIG,
    aliases: ['triglycerides', 'triglyceride', 'tg', 'serum triglycerides', 'triglycerides serum', 'tgl'],
    areas: { CARDIOVASCULAR: 3, METABOLIC: 2 }, direction: 'LOWER', group: 'LIPID_TG',
    preferred: { high: 150 }, critical: { high: 500 }, sig: { abs: 30, pct: 20 }, decimals: 0
  },
  {
    id: 'HDL_C', display: 'HDL Cholesterol', unit: 'mg/dL', units: U_CHOL,
    aliases: ['hdl', 'hdl cholesterol', 'hdl c', 'cholesterol hdl', 'high density lipoprotein',
      'high density lipoprotein cholesterol', 'serum hdl'],
    areas: { CARDIOVASCULAR: 3 }, direction: 'HIGHER', group: 'LIPID_HDL',
    preferred: { male: { low: 40 }, female: { low: 50 }, low: 40 },
    critical: { low: 20 }, sig: { abs: 5 }, decimals: 0
  },
  {
    id: 'TOTAL_CHOL', display: 'Total Cholesterol', unit: 'mg/dL', units: U_CHOL,
    aliases: ['total cholesterol', 'cholesterol total', 'cholesterol', 'serum cholesterol',
      'cholesterol serum', 't cholesterol'],
    areas: { CARDIOVASCULAR: 1 }, direction: 'LOWER', group: 'LIPID_ATHEROGENIC',
    preferred: { high: 200 }, critical: { high: 300 }, sig: { abs: 15, pct: 10 }, decimals: 0
  },
  {
    id: 'VLDL_C', display: 'VLDL Cholesterol', unit: 'mg/dL', units: U_CHOL,
    aliases: ['vldl', 'vldl cholesterol', 'cholesterol vldl', 'very low density lipoprotein'],
    areas: { CARDIOVASCULAR: 1 }, direction: 'LOWER', group: 'LIPID_TG',
    preferred: { high: 30 }, sig: { abs: 8, pct: 20 }, decimals: 0
  },
  {
    id: 'CHOL_HDL_RATIO', display: 'Total / HDL Ratio', unit: 'ratio', units: { '': 1, 'ratio': 1 },
    aliases: ['total cholesterol hdl ratio', 'chol hdl ratio', 'cholesterol hdl ratio',
      'tc hdl ratio', 'total hdl ratio', 'chol/hdl ratio'],
    areas: { CARDIOVASCULAR: 2 }, direction: 'LOWER', group: 'LIPID_RATIO',
    preferred: { high: 4.5 }, sig: { abs: 0.5 }, decimals: 1
  },
  {
    id: 'LDL_HDL_RATIO', display: 'LDL / HDL Ratio', unit: 'ratio', units: { '': 1, 'ratio': 1 },
    aliases: ['ldl hdl ratio', 'ldl/hdl ratio'],
    areas: { CARDIOVASCULAR: 1 }, direction: 'LOWER', group: 'LIPID_RATIO',
    preferred: { high: 3.0 }, sig: { abs: 0.4 }, decimals: 1
  },

  // ═══════════════════════════════ METABOLIC ═════════════════════════════════
  {
    id: 'HBA1C', display: 'HbA1c', unit: '%', units: { '%': 1, 'percent': 1, '': 1 },
    aliases: ['hba1c', 'a1c', 'hb a1c', 'glycated haemoglobin', 'glycated hemoglobin',
      'glycosylated haemoglobin', 'glycosylated hemoglobin', 'hba1c glycated hemoglobin',
      'haemoglobin a1c', 'hemoglobin a1c'],
    areas: { METABOLIC: 4 }, direction: 'LOWER', group: 'GLYCEMIA',
    preferred: { high: 5.7 }, critical: { high: 10 }, sig: { abs: 0.3 }, decimals: 1
  },
  {
    id: 'FASTING_GLUCOSE', display: 'Fasting Glucose', unit: 'mg/dL', units: U_GLUC,
    aliases: ['fasting glucose', 'glucose fasting', 'fasting blood sugar', 'blood sugar fasting',
      'fbs', 'fpg', 'glucose fasting plasma', 'plasma glucose fasting', 'sugar fasting',
      'fasting plasma glucose', 'glucose f'],
    areas: { METABOLIC: 3 }, direction: 'LOWER', group: 'GLYCEMIA',
    preferred: { low: 70, high: 99 }, critical: { low: 50, high: 400 }, sig: { abs: 10 }, decimals: 0
  },
  {
    id: 'POST_PRANDIAL_GLUCOSE', display: 'Post-prandial Glucose', unit: 'mg/dL', units: U_GLUC,
    aliases: ['post prandial glucose', 'postprandial glucose', 'pp glucose', 'ppbs',
      'blood sugar post prandial', 'glucose post prandial', 'post prandial blood sugar',
      'glucose pp', 'sugar pp', '2 hour post prandial glucose'],
    areas: { METABOLIC: 2 }, direction: 'LOWER', group: 'GLYCEMIA',
    preferred: { high: 140 }, critical: { high: 400 }, sig: { abs: 20, pct: 15 }, decimals: 0
  },
  {
    id: 'FASTING_INSULIN', display: 'Fasting Insulin', unit: 'µIU/mL', units: U_INSULIN,
    aliases: ['fasting insulin', 'insulin fasting', 'insulin', 'serum insulin', 'insulin serum fasting'],
    areas: { METABOLIC: 3 }, direction: 'LOWER', group: 'INSULIN_AXIS',
    preferred: { low: 2, high: 10 }, sig: { abs: 2, pct: 20 }, decimals: 1
  },
  {
    id: 'HOMA_IR', display: 'HOMA-IR', unit: 'index', units: { '': 1, 'index': 1 },
    aliases: ['homa ir', 'homair', 'homa index', 'insulin resistance index', 'homa'],
    areas: { METABOLIC: 3 }, direction: 'LOWER', group: 'INSULIN_AXIS',
    preferred: { high: 2.0 }, sig: { abs: 0.5, pct: 20 }, decimals: 2
  },

  // ═══════════════════════════════════ LIVER ═════════════════════════════════
  {
    id: 'ALT', display: 'ALT (SGPT)', unit: 'U/L', units: U_ENZ,
    aliases: ['alt', 'sgpt', 'alt sgpt', 'sgpt alt', 'alanine aminotransferase',
      'alanine transaminase', 'alanine aminotransferase alt', 'serum alt', 'sgpt serum'],
    areas: { LIVER: 4 }, direction: 'LOWER', group: 'LIVER_TRANSAMINASE',
    preferred: { high: 40 }, critical: { high: 500 }, sig: { abs: 10, pct: 25 }, decimals: 0
  },
  {
    id: 'AST', display: 'AST (SGOT)', unit: 'U/L', units: U_ENZ,
    aliases: ['ast', 'sgot', 'ast sgot', 'sgot ast', 'aspartate aminotransferase',
      'aspartate transaminase', 'serum ast', 'sgot serum'],
    areas: { LIVER: 3 }, direction: 'LOWER', group: 'LIVER_TRANSAMINASE',
    preferred: { high: 40 }, critical: { high: 500 }, sig: { abs: 10, pct: 25 }, decimals: 0
  },
  {
    id: 'GGT', display: 'GGT', unit: 'U/L', units: U_ENZ,
    aliases: ['ggt', 'gamma gt', 'gamma glutamyl transferase', 'gamma glutamyl transpeptidase',
      'ggtp', 'g gt'],
    areas: { LIVER: 3 }, direction: 'LOWER', group: 'LIVER_CHOLESTATIC',
    preferred: { high: 55 }, critical: { high: 400 }, sig: { abs: 10, pct: 25 }, decimals: 0
  },
  {
    id: 'ALP', display: 'Alkaline Phosphatase', unit: 'U/L', units: U_ENZ,
    aliases: ['alp', 'alkaline phosphatase', 'serum alkaline phosphatase', 'alk phos', 'alkp'],
    areas: { LIVER: 2 }, direction: 'RANGE', group: 'LIVER_CHOLESTATIC',
    preferred: { low: 40, high: 130 }, critical: { high: 500 }, sig: { abs: 20, pct: 25 }, decimals: 0
  },
  {
    id: 'BILIRUBIN_TOTAL', display: 'Total Bilirubin', unit: 'mg/dL', units: U_BILI,
    aliases: ['bilirubin total', 'total bilirubin', 'bilirubin', 'serum bilirubin total',
      't bilirubin', 'bilirubin t'],
    areas: { LIVER: 2 }, direction: 'LOWER', group: 'LIVER_BILIRUBIN',
    preferred: { high: 1.2 }, critical: { high: 5 }, sig: { abs: 0.4, pct: 30 }, decimals: 2
  },
  {
    id: 'BILIRUBIN_DIRECT', display: 'Direct Bilirubin', unit: 'mg/dL', units: U_BILI,
    aliases: ['bilirubin direct', 'direct bilirubin', 'conjugated bilirubin', 'd bilirubin'],
    areas: { LIVER: 2 }, direction: 'LOWER', group: 'LIVER_BILIRUBIN',
    preferred: { high: 0.3 }, critical: { high: 2 }, sig: { abs: 0.2, pct: 30 }, decimals: 2
  },
  {
    id: 'BILIRUBIN_INDIRECT', display: 'Indirect Bilirubin', unit: 'mg/dL', units: U_BILI,
    aliases: ['bilirubin indirect', 'indirect bilirubin', 'unconjugated bilirubin', 'i bilirubin'],
    areas: { LIVER: 1 }, direction: 'LOWER', group: 'LIVER_BILIRUBIN',
    preferred: { high: 1.0 }, sig: { abs: 0.3, pct: 30 }, decimals: 2
  },
  {
    id: 'ALBUMIN', display: 'Albumin', unit: 'g/dL', units: U_GDL,
    aliases: ['albumin', 'serum albumin', 'alb'],
    areas: { LIVER: 2 }, direction: 'RANGE', group: 'LIVER_PROTEIN',
    preferred: { low: 3.5, high: 5.2 }, critical: { low: 2.5 }, sig: { abs: 0.3 }, decimals: 1
  },
  {
    id: 'TOTAL_PROTEIN', display: 'Total Protein', unit: 'g/dL', units: U_GDL,
    aliases: ['total protein', 'protein total', 'serum total protein', 'total proteins', 't protein'],
    areas: { LIVER: 1 }, direction: 'RANGE', group: 'LIVER_PROTEIN',
    preferred: { low: 6.0, high: 8.3 }, sig: { abs: 0.4 }, decimals: 1
  },
  {
    id: 'GLOBULIN', display: 'Globulin', unit: 'g/dL', units: U_GDL,
    aliases: ['globulin', 'serum globulin', 'globulins'],
    areas: { LIVER: 1 }, direction: 'RANGE', group: 'LIVER_PROTEIN',
    preferred: { low: 2.0, high: 3.5 }, sig: { abs: 0.4 }, decimals: 1
  },
  {
    id: 'AG_RATIO', display: 'Albumin / Globulin Ratio', unit: 'ratio', units: { '': 1, 'ratio': 1 },
    aliases: ['a g ratio', 'ag ratio', 'albumin globulin ratio', 'alb glob ratio', 'a/g ratio'],
    areas: { LIVER: 1 }, direction: 'RANGE', group: 'LIVER_PROTEIN',
    preferred: { low: 1.0, high: 2.5 }, sig: { abs: 0.3 }, decimals: 1
  },

  // ═══════════════════════════════════ KIDNEY ════════════════════════════════
  {
    id: 'EGFR', display: 'eGFR', unit: 'mL/min/1.73m²',
    units: { 'ml/min/1.73m2': 1, 'ml/min/1.73sqm': 1, 'ml/min': 1, 'ml/min/1.73m^2': 1, '': 1 },
    aliases: ['egfr', 'e gfr', 'estimated gfr', 'gfr', 'glomerular filtration rate',
      'estimated glomerular filtration rate', 'egfr ckd epi', 'egfr mdrd'],
    areas: { KIDNEY: 4 }, direction: 'HIGHER', group: 'RENAL_FILTRATION',
    preferred: { low: 90 }, critical: { low: 30 }, sig: { abs: 5 }, decimals: 0
  },
  {
    id: 'CREATININE', display: 'Creatinine', unit: 'mg/dL', units: U_CREAT,
    aliases: ['creatinine', 'serum creatinine', 'creatinine serum', 'creat', 's creatinine'],
    areas: { KIDNEY: 3 }, direction: 'LOWER', group: 'RENAL_FILTRATION',
    preferred: { male: { low: 0.7, high: 1.3 }, female: { low: 0.6, high: 1.1 }, low: 0.6, high: 1.3 },
    critical: { high: 4.0 }, sig: { abs: 0.2 }, decimals: 2
  },
  {
    id: 'CYSTATIN_C', display: 'Cystatin C', unit: 'mg/L', units: { 'mg/l': 1 },
    aliases: ['cystatin c', 'cystatin'],
    areas: { KIDNEY: 3 }, direction: 'LOWER', group: 'RENAL_FILTRATION',
    preferred: { high: 1.0 }, sig: { abs: 0.15, pct: 15 }, decimals: 2
  },
  {
    id: 'UREA', display: 'Urea', unit: 'mg/dL', units: { 'mg/dl': 1, 'mmol/l': 6.006 },
    aliases: ['urea', 'serum urea', 'blood urea', 'urea serum'],
    areas: { KIDNEY: 2 }, direction: 'LOWER', group: 'RENAL_NITROGEN',
    preferred: { low: 15, high: 45 }, critical: { high: 150 }, sig: { abs: 8, pct: 25 }, decimals: 0,
    note: 'Urea and BUN measure the same thing on different scales (Urea ≈ BUN × 2.14). BodyBank keeps them separate and never converts between them.'
  },
  {
    id: 'BUN', display: 'Blood Urea Nitrogen (BUN)', unit: 'mg/dL', units: { 'mg/dl': 1 },
    aliases: ['bun', 'blood urea nitrogen', 'urea nitrogen', 'urea nitrogen blood', 'bun serum'],
    areas: { KIDNEY: 2 }, direction: 'LOWER', group: 'RENAL_NITROGEN',
    preferred: { low: 7, high: 20 }, critical: { high: 70 }, sig: { abs: 4, pct: 25 }, decimals: 0
  },
  {
    id: 'URIC_ACID', display: 'Uric Acid', unit: 'mg/dL', units: U_URIC,
    aliases: ['uric acid', 'serum uric acid', 'urate', 'uric acid serum'],
    areas: { KIDNEY: 2 }, direction: 'LOWER', group: 'RENAL_URATE',
    preferred: { male: { low: 3.4, high: 7.0 }, female: { low: 2.4, high: 6.0 }, low: 2.4, high: 7.0 },
    critical: { high: 12 }, sig: { abs: 0.8, pct: 15 }, decimals: 1
  },
  {
    id: 'SODIUM', display: 'Sodium', unit: 'mmol/L', units: U_MMOL,
    aliases: ['sodium', 'na', 'serum sodium', 'sodium serum', 'na+'],
    areas: { KIDNEY: 2 }, direction: 'RANGE', group: 'ELECTROLYTE_NA',
    preferred: { low: 135, high: 145 }, critical: { low: 120, high: 160 }, sig: { abs: 4 }, decimals: 0
  },
  {
    id: 'POTASSIUM', display: 'Potassium', unit: 'mmol/L', units: U_MMOL,
    aliases: ['potassium', 'k', 'serum potassium', 'potassium serum', 'k+'],
    areas: { KIDNEY: 3 }, direction: 'RANGE', group: 'ELECTROLYTE_K',
    preferred: { low: 3.5, high: 5.1 }, critical: { low: 2.5, high: 6.5 }, sig: { abs: 0.4 }, decimals: 1
  },
  {
    id: 'CHLORIDE', display: 'Chloride', unit: 'mmol/L', units: U_MMOL,
    aliases: ['chloride', 'cl', 'serum chloride', 'cl-'],
    areas: { KIDNEY: 1 }, direction: 'RANGE', group: 'ELECTROLYTE_CL',
    preferred: { low: 98, high: 107 }, critical: { low: 80, high: 120 }, sig: { abs: 4 }, decimals: 0
  },

  // ══════════════════════════════════ THYROID ════════════════════════════════
  {
    id: 'TSH', display: 'TSH', unit: 'µIU/mL', units: U_TSH,
    aliases: ['tsh', 'thyroid stimulating hormone', 'thyroid stimulating hormone tsh',
      's tsh', 'tsh ultrasensitive', 'tsh 3rd generation', 'thyrotropin'],
    areas: { THYROID: 4 }, direction: 'RANGE', group: 'THYROID_TSH',
    preferred: { low: 0.45, high: 4.5 }, critical: { low: 0.1, high: 10 }, sig: { abs: 0.5 }, decimals: 2
  },
  {
    id: 'FREE_T4', display: 'Free T4', unit: 'ng/dL', units: U_FT4,
    aliases: ['free t4', 'ft4', 'f t4', 'free thyroxine', 't4 free', 'thyroxine free'],
    areas: { THYROID: 3 }, direction: 'RANGE', group: 'THYROID_T4',
    preferred: { low: 0.82, high: 1.77 }, sig: { abs: 0.2, pct: 15 }, decimals: 2
  },
  {
    id: 'FREE_T3', display: 'Free T3', unit: 'pg/mL', units: U_FT3,
    aliases: ['free t3', 'ft3', 'f t3', 'free triiodothyronine', 't3 free', 'triiodothyronine free'],
    areas: { THYROID: 2 }, direction: 'RANGE', group: 'THYROID_T3',
    preferred: { low: 2.0, high: 4.4 }, sig: { abs: 0.4, pct: 15 }, decimals: 2
  },
  {
    id: 'TOTAL_T4', display: 'Total T4', unit: 'µg/dL', units: { 'ug/dl': 1, 'mcg/dl': 1, 'nmol/l': 1 / 12.87 },
    aliases: ['total t4', 't4', 't4 total', 'thyroxine', 'thyroxine total'],
    areas: { THYROID: 1 }, direction: 'RANGE', group: 'THYROID_T4',
    preferred: { low: 4.5, high: 12.0 }, sig: { pct: 15 }, decimals: 1
  },
  {
    id: 'TOTAL_T3', display: 'Total T3', unit: 'ng/dL', units: { 'ng/dl': 1, 'nmol/l': 65.1 },
    aliases: ['total t3', 't3', 't3 total', 'triiodothyronine', 'triiodothyronine total'],
    areas: { THYROID: 1 }, direction: 'RANGE', group: 'THYROID_T3',
    preferred: { low: 80, high: 200 }, sig: { pct: 15 }, decimals: 0
  },
  {
    id: 'ANTI_TPO', display: 'Anti-TPO Antibodies', unit: 'IU/mL', units: { 'iu/ml': 1, 'u/ml': 1, 'ku/l': 1 },
    aliases: ['anti tpo', 'antitpo', 'tpo antibody', 'anti thyroid peroxidase',
      'thyroid peroxidase antibody', 'anti tpo antibodies', 'tpo ab', 'atpo'],
    areas: { THYROID: 2 }, direction: 'LOWER', group: 'THYROID_AUTOIMMUNE',
    preferred: { high: 34 }, sig: { pct: 40 }, decimals: 0
  },

  // ═══════════════════════════════════ BLOOD ═════════════════════════════════
  {
    id: 'HEMOGLOBIN', display: 'Hemoglobin', unit: 'g/dL', units: U_GDL,
    aliases: ['hemoglobin', 'haemoglobin', 'hb', 'hgb', 'haemoglobin hb', 'hemoglobin hb',
      'blood hemoglobin', 'hemoglobin concentration'],
    areas: { BLOOD: 4 }, direction: 'RANGE', group: 'RBC_MASS',
    preferred: { male: { low: 13.0, high: 17.0 }, female: { low: 12.0, high: 15.5 }, low: 12.0, high: 17.0 },
    critical: { low: 7.0, high: 20.0 }, sig: { abs: 0.5 }, decimals: 1
  },
  {
    id: 'HEMATOCRIT', display: 'Hematocrit (PCV)', unit: '%', units: U_PCT,
    aliases: ['hematocrit', 'haematocrit', 'hct', 'pcv', 'packed cell volume', 'packed cell volume pcv'],
    areas: { BLOOD: 2 }, direction: 'RANGE', group: 'RBC_MASS',
    preferred: { male: { low: 40, high: 52 }, female: { low: 36, high: 46 }, low: 36, high: 52 },
    critical: { low: 21, high: 60 }, sig: { abs: 2 }, decimals: 1
  },
  {
    id: 'RBC', display: 'RBC Count', unit: 'mill/µL', units: U_MCELL,
    aliases: ['rbc', 'rbc count', 'red blood cell count', 'red blood cells', 'total rbc count',
      'erythrocyte count', 'rbc total count'],
    areas: { BLOOD: 2 }, direction: 'RANGE', group: 'RBC_MASS',
    preferred: { male: { low: 4.5, high: 5.9 }, female: { low: 4.0, high: 5.2 }, low: 4.0, high: 5.9 },
    sig: { abs: 0.3 }, decimals: 2
  },
  {
    id: 'MCV', display: 'MCV', unit: 'fL', units: { 'fl': 1, 'um3': 1, 'u3': 1 },
    aliases: ['mcv', 'mean corpuscular volume', 'mean cell volume'],
    areas: { BLOOD: 3 }, direction: 'RANGE', group: 'RBC_INDICES',
    preferred: { low: 80, high: 100 }, sig: { abs: 4 }, decimals: 1
  },
  {
    id: 'MCH', display: 'MCH', unit: 'pg', units: { 'pg': 1 },
    aliases: ['mch', 'mean corpuscular hemoglobin', 'mean corpuscular haemoglobin', 'mean cell hemoglobin'],
    areas: { BLOOD: 2 }, direction: 'RANGE', group: 'RBC_INDICES',
    preferred: { low: 27, high: 33 }, sig: { abs: 2 }, decimals: 1
  },
  {
    id: 'MCHC', display: 'MCHC', unit: 'g/dL', units: U_GDL,
    aliases: ['mchc', 'mean corpuscular hemoglobin concentration',
      'mean corpuscular haemoglobin concentration', 'mean cell hemoglobin concentration'],
    areas: { BLOOD: 2 }, direction: 'RANGE', group: 'RBC_INDICES',
    preferred: { low: 32, high: 36 }, sig: { abs: 1.5 }, decimals: 1
  },
  {
    id: 'RDW', display: 'RDW', unit: '%', units: U_PCT,
    aliases: ['rdw', 'rdw cv', 'red cell distribution width', 'rbc distribution width', 'rdw sd'],
    areas: { BLOOD: 2 }, direction: 'LOWER', group: 'RBC_RDW',
    preferred: { low: 11.5, high: 14.5 }, sig: { abs: 1.5 }, decimals: 1
  },
  {
    id: 'WBC', display: 'WBC (Total Leukocyte Count)', unit: 'K/µL', units: U_KCELL,
    aliases: ['wbc', 'wbc count', 'white blood cell count', 'white blood cells', 'tlc',
      'total leucocyte count', 'total leukocyte count', 'total wbc count', 'leucocyte count'],
    areas: { BLOOD: 3, INFLAMMATION: 1 }, direction: 'RANGE', group: 'WBC_TOTAL',
    preferred: { low: 4.0, high: 11.0 }, critical: { low: 2.0, high: 30.0 }, sig: { abs: 1.5, pct: 25 }, decimals: 1
  },
  {
    id: 'PLATELETS', display: 'Platelet Count', unit: 'K/µL', units: U_KCELL,
    aliases: ['platelets', 'platelet count', 'plt', 'thrombocyte count', 'total platelet count'],
    areas: { BLOOD: 3 }, direction: 'RANGE', group: 'PLATELETS',
    preferred: { low: 150, high: 410 }, critical: { low: 50, high: 1000 }, sig: { abs: 30, pct: 20 }, decimals: 0
  },
  {
    id: 'NEUTROPHILS', display: 'Neutrophils', unit: '%', units: U_PCT,
    aliases: ['neutrophils', 'neutrophil', 'neutrophils percentage', 'polymorphs', 'segmented neutrophils'],
    areas: { BLOOD: 1, INFLAMMATION: 1 }, direction: 'RANGE', group: 'WBC_DIFF',
    preferred: { low: 40, high: 75 }, sig: { abs: 8 }, decimals: 1
  },
  {
    id: 'LYMPHOCYTES', display: 'Lymphocytes', unit: '%', units: U_PCT,
    aliases: ['lymphocytes', 'lymphocyte', 'lymphocytes percentage', 'lymphs'],
    areas: { BLOOD: 1, INFLAMMATION: 1 }, direction: 'RANGE', group: 'WBC_DIFF',
    preferred: { low: 20, high: 45 }, sig: { abs: 8 }, decimals: 1
  },
  {
    id: 'EOSINOPHILS', display: 'Eosinophils', unit: '%', units: U_PCT,
    aliases: ['eosinophils', 'eosinophil', 'eosinophils percentage', 'eos'],
    areas: { BLOOD: 1, INFLAMMATION: 1 }, direction: 'RANGE', group: 'WBC_DIFF',
    preferred: { low: 1, high: 6 }, sig: { abs: 2 }, decimals: 1
  },
  {
    id: 'MONOCYTES', display: 'Monocytes', unit: '%', units: U_PCT,
    aliases: ['monocytes', 'monocyte', 'monocytes percentage', 'mono'],
    areas: { BLOOD: 1, INFLAMMATION: 1 }, direction: 'RANGE', group: 'WBC_DIFF',
    preferred: { low: 2, high: 10 }, sig: { abs: 3 }, decimals: 1
  },
  {
    id: 'BASOPHILS', display: 'Basophils', unit: '%', units: U_PCT,
    aliases: ['basophils', 'basophil', 'basophils percentage', 'baso'],
    areas: { BLOOD: 1, INFLAMMATION: 1 }, direction: 'RANGE', group: 'WBC_DIFF',
    preferred: { low: 0, high: 2 }, sig: { abs: 1 }, decimals: 1
  },

  // ════════════════════════════════ NUTRITIONAL ══════════════════════════════
  {
    id: 'VITAMIN_D', display: 'Vitamin D (25-OH)', unit: 'ng/mL', units: U_VITD,
    aliases: ['vitamin d', 'vitamin d3', 'vitamin d 25 oh', '25 oh vitamin d', '25 hydroxyvitamin d',
      '25 hydroxy vitamin d', 'vitamin d total', '25 oh vitamin d total', 'vit d',
      'vitamin d 25 hydroxy', 'calcidiol'],
    areas: { NUTRITIONAL: 3 }, direction: 'HIGHER', group: 'VIT_D',
    preferred: { low: 30, high: 100 }, critical: { low: 10 }, sig: { abs: 5 }, decimals: 1
  },
  {
    id: 'VITAMIN_B12', display: 'Vitamin B12', unit: 'pg/mL', units: U_B12,
    aliases: ['vitamin b12', 'b12', 'cobalamin', 'vit b12', 'vitamin b 12', 'cyanocobalamin',
      'vitamin b12 serum', 'b 12'],
    areas: { NUTRITIONAL: 3 }, direction: 'HIGHER', group: 'VIT_B12',
    preferred: { low: 300, high: 900 }, critical: { low: 150 }, sig: { abs: 50, pct: 20 }, decimals: 0
  },
  {
    id: 'FOLATE', display: 'Folate', unit: 'ng/mL', units: U_FOLATE,
    aliases: ['folate', 'folic acid', 'serum folate', 'vitamin b9', 'folate serum'],
    areas: { NUTRITIONAL: 2 }, direction: 'HIGHER', group: 'FOLATE',
    preferred: { low: 4.0 }, critical: { low: 2.0 }, sig: { abs: 2, pct: 25 }, decimals: 1
  },
  {
    id: 'FERRITIN', display: 'Ferritin', unit: 'ng/mL', units: U_FERR,
    aliases: ['ferritin', 'serum ferritin', 'ferritin serum'],
    areas: { NUTRITIONAL: 3 }, direction: 'RANGE', group: 'IRON_STORES',
    preferred: { male: { low: 30, high: 400 }, female: { low: 30, high: 200 }, low: 30, high: 400 },
    critical: { high: 1000 }, sig: { abs: 20, pct: 25 }, decimals: 0,
    note: 'Ferritin rises with inflammation, so a mid-range result does not always rule out low iron stores.'
  },
  {
    id: 'SERUM_IRON', display: 'Serum Iron', unit: 'µg/dL', units: U_IRON,
    aliases: ['iron', 'serum iron', 'iron serum', 's iron', 'total iron'],
    areas: { NUTRITIONAL: 2 }, direction: 'RANGE', group: 'IRON_TRANSPORT',
    preferred: { low: 60, high: 170 }, sig: { abs: 25, pct: 25 }, decimals: 0
  },
  {
    id: 'TIBC', display: 'TIBC', unit: 'µg/dL', units: U_IRON,
    aliases: ['tibc', 'total iron binding capacity', 'iron binding capacity total'],
    areas: { NUTRITIONAL: 1 }, direction: 'RANGE', group: 'IRON_TRANSPORT',
    preferred: { low: 250, high: 450 }, sig: { abs: 50, pct: 20 }, decimals: 0
  },
  {
    id: 'TRANSFERRIN_SAT', display: 'Transferrin Saturation', unit: '%', units: U_PCT,
    aliases: ['transferrin saturation', 'transferrin sat', 'tsat', 'saturation transferrin',
      'iron saturation', 'transferrin saturation index'],
    areas: { NUTRITIONAL: 2 }, direction: 'RANGE', group: 'IRON_TRANSPORT',
    preferred: { low: 20, high: 50 }, sig: { abs: 6, pct: 25 }, decimals: 1
  },
  {
    id: 'CALCIUM', display: 'Calcium', unit: 'mg/dL', units: U_CALC,
    aliases: ['calcium', 'serum calcium', 'total calcium', 'calcium total', 'ca'],
    areas: { NUTRITIONAL: 2 }, direction: 'RANGE', group: 'MINERAL_CA',
    preferred: { low: 8.6, high: 10.3 }, critical: { low: 7.0, high: 13.0 }, sig: { abs: 0.5 }, decimals: 1
  },
  {
    id: 'MAGNESIUM', display: 'Magnesium', unit: 'mg/dL', units: U_MAG,
    aliases: ['magnesium', 'serum magnesium', 'mg'],
    areas: { NUTRITIONAL: 2 }, direction: 'RANGE', group: 'MINERAL_MG',
    preferred: { low: 1.7, high: 2.4 }, critical: { low: 1.2, high: 4.0 }, sig: { abs: 0.3 }, decimals: 2
  },
  {
    id: 'ZINC', display: 'Zinc', unit: 'µg/dL', units: { 'ug/dl': 1, 'mcg/dl': 1, 'umol/l': 6.538 },
    aliases: ['zinc', 'serum zinc', 'zn'],
    areas: { NUTRITIONAL: 1 }, direction: 'RANGE', group: 'MINERAL_ZN',
    preferred: { low: 70, high: 120 }, sig: { abs: 15, pct: 20 }, decimals: 0
  },
  {
    id: 'PHOSPHORUS', display: 'Phosphorus', unit: 'mg/dL', units: { 'mg/dl': 1, 'mmol/l': 3.097 },
    aliases: ['phosphorus', 'serum phosphorus', 'phosphate', 'inorganic phosphorus', 'p'],
    areas: { NUTRITIONAL: 1 }, direction: 'RANGE', group: 'MINERAL_PHOS',
    preferred: { low: 2.5, high: 4.5 }, critical: { low: 1.0, high: 8.0 }, sig: { abs: 0.5 }, decimals: 1
  },

  // ═══════════════════════════════ INFLAMMATION ══════════════════════════════
  {
    id: 'HS_CRP', display: 'hs-CRP', unit: 'mg/L', units: U_CRP,
    aliases: ['hs crp', 'hscrp', 'high sensitivity crp', 'hs c reactive protein',
      'high sensitivity c reactive protein', 'crp high sensitivity', 'ultra sensitive crp'],
    areas: { INFLAMMATION: 4, CARDIOVASCULAR: 2 }, direction: 'LOWER', group: 'CRP',
    preferred: { high: 1.0 }, critical: { high: 50 }, sig: { abs: 1.0, pct: 50 }, decimals: 2
  },
  {
    id: 'CRP', display: 'CRP', unit: 'mg/L', units: U_CRP,
    aliases: ['crp', 'c reactive protein', 'crp quantitative', 'c reactive protein crp'],
    areas: { INFLAMMATION: 3 }, direction: 'LOWER', group: 'CRP',
    preferred: { high: 5.0 }, critical: { high: 100 }, sig: { abs: 3, pct: 50 }, decimals: 1
  },
  {
    id: 'ESR', display: 'ESR', unit: 'mm/hr', units: { 'mm/hr': 1, 'mm/h': 1, 'mm1sthour': 1, 'mm/1hr': 1 },
    aliases: ['esr', 'erythrocyte sedimentation rate', 'sedimentation rate', 'esr westergren'],
    areas: { INFLAMMATION: 3 }, direction: 'LOWER', group: 'ESR',
    preferred: { male: { high: 15 }, female: { high: 20 }, high: 20 },
    critical: { high: 100 }, sig: { abs: 8, pct: 30 }, decimals: 0
  }
];

// ---------------------------------------------------------------------------
// Indexes (built once at require time)
// ---------------------------------------------------------------------------

const BY_ID = new Map();
const BY_ALIAS = new Map();

/** Collision guard: two markers must never claim the same alias. */
const ALIAS_COLLISIONS = [];

MARKERS.forEach((m) => {
  if (BY_ID.has(m.id)) throw new Error(`markerRegistry: duplicate id ${m.id}`);
  BY_ID.set(m.id, m);
  // The canonical display name is always an alias of itself.
  const own = [m.display].concat(m.aliases || []);
  own.forEach((a) => {
    const key = normalizeMarkerName(a);
    if (!key) return;
    const prev = BY_ALIAS.get(key);
    if (prev && prev !== m.id) {
      ALIAS_COLLISIONS.push(`"${a}" → ${prev} and ${m.id}`);
      return; // first registration wins; the collision is reported by the test suite
    }
    BY_ALIAS.set(key, m.id);
  });
});

/**
 * Resolve a printed lab marker name to a registry entry.
 * Matching is exact-on-normalised-name only — no fuzzy matching, because a wrong
 * match silently produces a wrong grade. Unknown names are UNMAPPED by design and
 * still render in the report's "Other Results" group.
 * @param {string} name
 * @returns {object|null}
 */
function lookupMarker(name) {
  const key = normalizeMarkerName(name);
  if (!key) return null;
  const id = BY_ALIAS.get(key);
  if (id) return BY_ID.get(id);

  // One conservative retry: strip a leading "serum"/"plasma"/"blood"/"total" qualifier
  // that some labs prepend. Only applied when the remainder is itself a known alias.
  const stripped = key.replace(/^(serum|plasma|blood|s|p)\s+/, '');
  if (stripped !== key && BY_ALIAS.has(stripped)) return BY_ID.get(BY_ALIAS.get(stripped));
  return null;
}

/** @returns {object|null} registry entry by canonical id. */
function getMarker(id) {
  return BY_ID.get(String(id || '')) || null;
}

/**
 * Convert a value from a printed unit into the marker's canonical unit.
 * @returns {{ value:number, converted:boolean }|null} null = unit not recognised,
 *          caller must NOT apply preferred ranges, critical checks or comparisons.
 */
function toCanonicalUnit(marker, value, printedUnit) {
  if (!marker || value == null || !Number.isFinite(value)) return null;
  const map = marker.units || {};
  const key = normalizeUnit(printedUnit);
  // An empty printed unit is accepted only for unitless markers (ratios, indices, %).
  if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
  const factor = map[key];
  return { value: value * factor, converted: factor !== 1 };
}

/**
 * The BodyBank preferred range for this marker, resolved for the client's sex.
 * @param {object} marker
 * @param {string} sex 'male' | 'female' | anything else
 * @returns {{low?:number, high?:number}|null}
 */
function preferredRange(marker, sex) {
  const p = marker && marker.preferred;
  if (!p) return null;
  const s = String(sex || '').trim().toLowerCase();
  if (s.startsWith('m') && p.male) return p.male;
  if (s.startsWith('f') && p.female) return p.female;
  if (p.low != null || p.high != null) return { low: p.low, high: p.high };
  return null;
}

/** All markers that can contribute to an area, with their weight there. */
function markersForArea(areaId) {
  return MARKERS.filter((m) => m.areas && m.areas[areaId] != null);
}

/** Weight of a marker inside an area (0 when it does not belong there). */
function weightIn(markerId, areaId) {
  const m = BY_ID.get(markerId);
  return (m && m.areas && m.areas[areaId]) || 0;
}

module.exports = {
  REGISTRY_VERSION,
  AREAS,
  AREA_ORDER,
  MARKERS,
  ALIAS_COLLISIONS,
  lookupMarker,
  getMarker,
  toCanonicalUnit,
  normalizeUnit,
  preferredRange,
  markersForArea,
  weightIn
};
