'use strict';

/**
 * BodyBank — graded health report: engine test suite.
 *
 *   node tests/graded-report-engines.js
 *
 * Covers the four pure engines behind the graded report variant: the marker
 * registry, the deterministic classifier, the grading rules, the comparison
 * thresholds and the priority selection — plus the medical-safety constraints that
 * must hold on every string the report can emit.
 *
 * The existing 'classic' report is not touched by any of this, and
 * tests/graded-report-isolation.js proves that separately.
 */

const registry = require('../services/grading/markerRegistry');
const classify = require('../services/grading/classify');
const rules = require('../services/grading/rules');
const grading = require('../services/grading');
const copy = require('../services/grading/copy');
const comparison = require('../services/comparison');
const priority = require('../services/priority');
const { buildGradedHealthReport } = require('../services/gradedHealthReport');

const { STATUS, SEVERITY } = classify;
const { TREND } = comparison;

let passed = 0;
const failures = [];
let group = '';

function section(name) { group = name; }
function ok(name, cond, detail) {
  if (cond) { passed += 1; return; }
  failures.push(`[${group}] ${name}` + (detail ? ` :: ${detail}` : ''));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

const mk = (name, value, unit, ref) => ({ name, value, unit, reference_range: ref });
const panel = (name, markers) => ({ name, markers });
const extract = (...panels) => ({ panels });

/** Classify + grade in one step, returning both halves. */
function grade(extracted, sex) {
  return grading.gradeExtractedReport(extracted, { sex: sex || 'male' });
}
function areaOf(result, areaId) {
  return result.areas.filter((a) => a.areaId === areaId)[0];
}
/** A lipid panel that satisfies cardiovascular sufficiency, parameterised. */
function lipids(ldl, hdl, tg, tc) {
  const m = [mk('LDL Cholesterol', String(ldl), 'mg/dL', '0-100'),
    mk('HDL Cholesterol', String(hdl), 'mg/dL', '40-60'),
    mk('Triglycerides', String(tg), 'mg/dL', '0-150')];
  if (tc != null) m.push(mk('Total Cholesterol', String(tc), 'mg/dL', '0-200'));
  return panel('Lipid Profile', m);
}

// ===========================================================================
section('registry');
// ===========================================================================

eq('no alias collisions between markers', registry.ALIAS_COLLISIONS.length, 0);
ok('collision detail is empty', registry.ALIAS_COLLISIONS.length === 0,
  registry.ALIAS_COLLISIONS.join(' | '));

const seenIds = new Set();
registry.MARKERS.forEach((m) => {
  ok(`${m.id}: unique id`, !seenIds.has(m.id));
  seenIds.add(m.id);
  ok(`${m.id}: has display name`, !!m.display);
  ok(`${m.id}: has a canonical unit`, typeof m.unit === 'string');
  ok(`${m.id}: has a unit map`, m.units && typeof m.units === 'object');
  ok(`${m.id}: declares a correlation group`, !!m.group);
  ok(`${m.id}: direction is valid`, ['LOWER', 'HIGHER', 'RANGE'].indexOf(m.direction) >= 0, m.direction);
  ok(`${m.id}: every area is real`, Object.keys(m.areas || {}).every((a) => !!registry.AREAS[a]));
  ok(`${m.id}: every weight is 1..4`,
    Object.keys(m.areas || {}).every((a) => m.areas[a] >= 1 && m.areas[a] <= 4));
  // A canonical unit that the unit map cannot express would silently disable every
  // preferred range and critical bound for that marker.
  const canonKey = registry.normalizeUnit(m.unit);
  ok(`${m.id}: canonical unit "${m.unit}" is in its own unit map`,
    Object.prototype.hasOwnProperty.call(m.units, canonKey), `looked for "${canonKey}"`);
  if (m.critical) {
    ok(`${m.id}: critical bounds are ordered`,
      m.critical.low == null || m.critical.high == null || m.critical.low < m.critical.high);
  }
});

// Correlated markers named in the brief must actually share a group.
const sameGroup = (a, b) => registry.getMarker(a).group === registry.getMarker(b).group;
ok('Total Cholesterol and LDL share a correlation group', sameGroup('TOTAL_CHOL', 'LDL_C'));
ok('Hemoglobin and Hematocrit share a correlation group', sameGroup('HEMOGLOBIN', 'HEMATOCRIT'));
ok('AST and ALT share a correlation group', sameGroup('AST', 'ALT'));
ok('Creatinine and eGFR share a correlation group', sameGroup('CREATININE', 'EGFR'));
ok('HbA1c and fasting glucose share a correlation group', sameGroup('HBA1C', 'FASTING_GLUCOSE'));
ok('Urea and BUN share a correlation group', sameGroup('UREA', 'BUN'));

// Lookups a real Indian lab report will throw at us.
[['SGPT', 'ALT'], ['SGOT', 'AST'], ['Haemoglobin', 'HEMOGLOBIN'], ['PCV', 'HEMATOCRIT'],
  ['Total Leucocyte Count', 'WBC'], ['25-Hydroxy Vitamin D', 'VITAMIN_D'],
  ['HbA1c (Glycated Hemoglobin)', 'HBA1C'], ['Serum Creatinine', 'CREATININE'],
  ['Blood Urea Nitrogen', 'BUN'], ['Cholesterol - Total', 'TOTAL_CHOL'],
  ['Thyroid Stimulating Hormone (TSH)', 'TSH'], ['Vitamin B12', 'VITAMIN_B12']
].forEach(([printed, id]) => {
  const m = registry.lookupMarker(printed);
  eq(`lookup "${printed}"`, m ? m.id : null, id);
});
eq('unknown marker stays unmapped', registry.lookupMarker('Sputum Culture Result'), null);
eq('empty name stays unmapped', registry.lookupMarker(''), null);

// Unit conversion.
const ldlReg = registry.getMarker('LDL_C');
ok('mmol/L LDL converts to mg/dL',
  Math.abs(registry.toCanonicalUnit(ldlReg, 3.5, 'mmol/L').value - 135.345) < 0.01);
eq('unrecognised unit refuses to convert', registry.toCanonicalUnit(ldlReg, 135, 'furlongs'), null);
eq('sex-specific preferred range — male', registry.preferredRange(registry.getMarker('HDL_C'), 'Male').low, 40);
eq('sex-specific preferred range — female', registry.preferredRange(registry.getMarker('HDL_C'), 'female').low, 50);
eq('sex-specific preferred range — unknown sex falls back',
  registry.preferredRange(registry.getMarker('HDL_C'), '').low, 40);

// ===========================================================================
section('classify — status ladder');
// ===========================================================================

const c = (name, value, unit, ref, status) =>
  classify.classifyMarker(mk(name, value, unit, ref) && Object.assign(mk(name, value, unit, ref), { status }), { sex: 'male' });

eq('inside range', c('LDL Cholesterol', '70', 'mg/dL', '0-100').status, STATUS.WITHIN_RANGE);
eq('above range', c('LDL Cholesterol', '142', 'mg/dL', '0-100').status, STATUS.HIGH);
eq('below range', c('HDL Cholesterol', '30', 'mg/dL', '40-60').status, STATUS.LOW);
eq('borderline high (inside, within 5% band)', c('LDL Cholesterol', '99', 'mg/dL', '0-100').status, STATUS.BORDERLINE_HIGH);
eq('borderline low', c('HDL Cholesterol', '41', 'mg/dL', '40-60').status, STATUS.BORDERLINE_LOW);
eq('exactly on the upper bound is still inside', c('LDL Cholesterol', '100', 'mg/dL', '0-100').status, STATUS.BORDERLINE_HIGH);
eq('one above the upper bound is out', c('LDL Cholesterol', '101', 'mg/dL', '0-100').status, STATUS.HIGH);

// The zero-lower-bound guard: basophils 0–2 must not read as borderline low at 0.
eq('a zero lower bound has no borderline band', c('Basophils', '0', '%', '0-2').status, STATUS.WITHIN_RANGE);

// Critical overlay.
eq('critical high', c('Potassium', '6.9', 'mmol/L', '3.5-5.1').status, STATUS.CRITICAL_HIGH);
eq('critical low', c('Hemoglobin', '6.2', 'g/dL', '13.0-17.0').status, STATUS.CRITICAL_LOW);
eq('a high value below the critical bound stays HIGH',
  c('Potassium', '5.4', 'mmol/L', '3.5-5.1').status, STATUS.HIGH);

// Source of truth.
eq('lab range wins', c('LDL Cholesterol', '142', 'mg/dL', '0-100').statusSource, 'DERIVED_LAB');
eq('no lab range falls back to BodyBank preferred',
  c('TSH', '2.1', 'uIU/mL', '').statusSource, 'DERIVED_PREFERRED');
eq('preferred range is labelled as BodyBank',
  c('TSH', '2.1', 'uIU/mL', '').referenceRange.source, 'BODYBANK_PREFERRED');
eq('preferred range converts units first',
  c('Vitamin D', '45', 'nmol/L', '').status, STATUS.LOW);

// The extracted (model-written) status may be shown but must never be gradable.
const extractedOnly = c('Some Novel Assay', '12', 'arbitrary', '', 'High');
eq('unknown marker + no range = extracted source', extractedOnly.statusSource, 'EXTRACTED');
eq('extracted status is never gradable', extractedOnly.gradable, false);
eq('extracted status carries no severity', extractedOnly.severity, SEVERITY.NONE);
eq('non-numeric result is NOT_AVAILABLE', c('Urine Colour', 'Pale yellow', '', '').status, STATUS.NOT_AVAILABLE);

// Duplicate markers across panels.
const dupReport = classify.classifyReport(extract(
  panel('Lipid Profile', [mk('HDL Cholesterol', '38', 'mg/dL', '40-60')]),
  panel('Cardiac Risk', [mk('HDL', '38', 'mg/dL', '40-60')])
), { sex: 'male' });
eq('a repeated marker still appears in the table', dupReport.markers.length, 2);
eq('only one copy is indexed', dupReport.byId.size, 1);
eq('the second copy is flagged as a duplicate', dupReport.markers[1].duplicate, true);
eq('the second copy cannot grade', dupReport.markers[1].gradable, false);

// ===========================================================================
section('grading — sufficiency');
// ===========================================================================

// Each area's minimum set, tested one marker below the line and exactly on it.
const suffCases = [
  ['CARDIOVASCULAR', extract(panel('L', [mk('LDL Cholesterol', '90', 'mg/dL', '0-100')])), false],
  ['CARDIOVASCULAR', extract(panel('L', [mk('LDL Cholesterol', '90', 'mg/dL', '0-100'),
    mk('HDL Cholesterol', '50', 'mg/dL', '40-60')])), true],
  ['METABOLIC', extract(panel('M', [mk('Fasting Insulin', '5', 'uIU/mL', '2-10')])), false],
  ['METABOLIC', extract(panel('M', [mk('HbA1c', '5.2', '%', '4.0-5.6')])), true],
  ['LIVER', extract(panel('L', [mk('SGPT', '30', 'U/L', '0-40')])), false],
  ['LIVER', extract(panel('L', [mk('SGPT', '30', 'U/L', '0-40'), mk('SGOT', '28', 'U/L', '0-40')])), true],
  ['KIDNEY', extract(panel('K', [mk('Blood Urea', '30', 'mg/dL', '15-45')])), false],
  ['KIDNEY', extract(panel('K', [mk('Serum Creatinine', '0.9', 'mg/dL', '0.7-1.3')])), true],
  ['THYROID', extract(panel('T', [mk('Free T4', '1.1', 'ng/dL', '0.82-1.77')])), false],
  ['THYROID', extract(panel('T', [mk('TSH', '2.0', 'uIU/mL', '0.45-4.5')])), true],
  ['BLOOD', extract(panel('C', [mk('Haemoglobin', '14', 'g/dL', '13-17'),
    mk('MCV', '88', 'fL', '80-100')])), false],
  ['BLOOD', extract(panel('C', [mk('Haemoglobin', '14', 'g/dL', '13-17'),
    mk('MCV', '88', 'fL', '80-100'), mk('Platelet Count', '250', 'K/uL', '150-410')])), true],
  ['NUTRITIONAL', extract(panel('N', [mk('Vitamin D', '40', 'ng/mL', '30-100')])), false],
  ['NUTRITIONAL', extract(panel('N', [mk('Vitamin D', '40', 'ng/mL', '30-100'),
    mk('Ferritin', '80', 'ng/mL', '30-400')])), true],
  ['INFLAMMATION', extract(panel('I', [mk('Platelet Count', '250', 'K/uL', '150-410')])), false],
  ['INFLAMMATION', extract(panel('I', [mk('hs-CRP', '0.8', 'mg/L', '0-3')])), true]
];
suffCases.forEach(([areaId, ext, shouldGrade]) => {
  const a = areaOf(grade(ext), areaId);
  eq(`${areaId} sufficiency ${shouldGrade ? 'met' : 'not met'}`,
    a.grade !== 'NOT_ASSESSED', shouldGrade);
  if (!shouldGrade) {
    ok(`${areaId} names what is missing`, a.markersMissing.length > 0);
    ok(`${areaId} explains the requirement`, !!a.sufficiencyDescribe);
  }
});

eq('body composition is never inferred from blood',
  areaOf(grade(extract(lipids(90, 50, 100))), 'BODY_COMPOSITION').grade, 'NOT_ASSESSED');

// ===========================================================================
section('grading — ceilings and accumulation');
// ===========================================================================

eq('all within range grades A', areaOf(grade(extract(lipids(80, 55, 110))), 'CARDIOVASCULAR').grade, 'A');
eq('a single borderline caps at B', areaOf(grade(extract(lipids(99, 55, 110))), 'CARDIOVASCULAR').grade, 'B');
eq('a single high-weight abnormal caps at C',
  areaOf(grade(extract(lipids(142, 55, 110))), 'CARDIOVASCULAR').grade, 'C');
eq('a critical marker forces D',
  areaOf(grade(extract(lipids(210, 55, 110))), 'CARDIOVASCULAR').grade, 'D');

// A low-weight abnormality alone should not reach C.
const lowWeightOnly = grade(extract(panel('K', [
  mk('Serum Creatinine', '1.0', 'mg/dL', '0.7-1.3'),
  mk('Chloride', '112', 'mmol/L', '98-107')
])));
eq('a weight-1 abnormality caps at B', areaOf(lowWeightOnly, 'KIDNEY').grade, 'B');

// ===========================================================================
section('grading — correlation guard (no double counting)');
// ===========================================================================

// Total cholesterol is mostly LDL. Adding a raised TC to a raised LDL must not
// escalate the grade, because it is the same finding measured twice.
const ldlOnly = areaOf(grade(extract(lipids(142, 55, 110))), 'CARDIOVASCULAR');
const ldlPlusTc = areaOf(grade(extract(lipids(142, 55, 110, 245))), 'CARDIOVASCULAR');
eq('adding correlated Total Cholesterol does not change the grade', ldlPlusTc.grade, ldlOnly.grade);
eq('adding correlated Total Cholesterol does not change the score', ldlPlusTc.score, ldlOnly.score);
ok('the correlation guard is recorded in the rationale',
  ldlPlusTc.gradeRationale.some((r) => r.indexOf('CORRELATION_GUARD') === 0));

// Red cell mass: Hb + Hct + RBC are one finding, not three.
const hbOnly = areaOf(grade(extract(panel('C', [
  mk('Haemoglobin', '11.0', 'g/dL', '13.0-17.0'),
  mk('Platelet Count', '250', 'K/uL', '150-410'),
  mk('Total Leucocyte Count', '7.0', 'K/uL', '4.0-11.0')
]))), 'BLOOD');
const hbHctRbc = areaOf(grade(extract(panel('C', [
  mk('Haemoglobin', '11.0', 'g/dL', '13.0-17.0'),
  mk('PCV', '33', '%', '40-52'),
  mk('RBC Count', '4.0', 'mill/uL', '4.5-5.9'),
  mk('Platelet Count', '250', 'K/uL', '150-410'),
  mk('Total Leucocyte Count', '7.0', 'K/uL', '4.0-11.0')
]))), 'BLOOD');
eq('Hb/Hct/RBC score once, not three times', hbHctRbc.score, hbOnly.score);

// Transaminases.
const altOnly = areaOf(grade(extract(panel('L', [
  mk('SGPT', '62', 'U/L', '0-40'), mk('Alkaline Phosphatase', '90', 'U/L', '40-130')
]))), 'LIVER');
const altAst = areaOf(grade(extract(panel('L', [
  mk('SGPT', '62', 'U/L', '0-40'), mk('SGOT', '58', 'U/L', '0-40'),
  mk('Alkaline Phosphatase', '90', 'U/L', '40-130')
]))), 'LIVER');
eq('ALT and AST score once', altAst.score, altOnly.score);

// Glycemia: HbA1c must outweigh, not stack with, fasting glucose.
const a1cOnly = areaOf(grade(extract(panel('M', [mk('HbA1c', '6.0', '%', '4.0-5.6')]))), 'METABOLIC');
const a1cPlusGlucose = areaOf(grade(extract(panel('M', [
  mk('HbA1c', '6.0', '%', '4.0-5.6'), mk('Fasting Blood Sugar', '112', 'mg/dL', '70-100')
]))), 'METABOLIC');
eq('HbA1c and fasting glucose score once', a1cPlusGlucose.score, a1cOnly.score);

// ===========================================================================
section('grading — direction awareness');
// ===========================================================================

// An LDL below its range is a fact, but not a cardiovascular concern.
const lowLdl = grade(extract(panel('L', [
  mk('LDL Cholesterol', '35', 'mg/dL', '50-100'),
  mk('HDL Cholesterol', '55', 'mg/dL', '40-60'),
  mk('Triglycerides', '100', 'mg/dL', '0-150')
])));
const lowLdlArea = areaOf(lowLdl, 'CARDIOVASCULAR');
eq('a favourable-direction deviation still prints as LOW',
  lowLdl.classified.byId.get('LDL_C').status, STATUS.LOW);
eq('a favourable-direction deviation does not lower the grade', lowLdlArea.grade, 'A');
ok('the disregard is recorded in the rationale',
  lowLdlArea.gradeRationale.some((r) => r.indexOf('DISREGARDED') === 0));

// A low HDL, by contrast, is unfavourable.
eq('an unfavourable-direction deviation does lower the grade',
  areaOf(grade(extract(lipids(80, 30, 110))), 'CARDIOVASCULAR').grade, 'C');

// ===========================================================================
section('grading — pattern rules');
// ===========================================================================

function firedIn(result, areaId, patternId) {
  const a = areaOf(result, areaId);
  return a.patternsFired.some((p) => p.id === patternId);
}

// P1 atherogenic: high TG + low HDL, each only mildly out.
const p1 = grade(extract(lipids(90, 38, 160)));
ok('P1 fires on high TG with low HDL', firedIn(p1, 'CARDIOVASCULAR', 'P1'));
ok('P1 floors cardiovascular at C', rules.rank(areaOf(p1, 'CARDIOVASCULAR').grade) >= rules.rank('C'));

// P3 iron deficiency, and its inflammation suppression.
const ironPanels = (crp) => {
  const p = [panel('C', [mk('Haemoglobin', '10.5', 'g/dL', '13.0-17.0'),
    mk('MCV', '72', 'fL', '80-100'), mk('Platelet Count', '250', 'K/uL', '150-410'),
    mk('Total Leucocyte Count', '7.0', 'K/uL', '4.0-11.0')]),
  panel('I', [mk('Ferritin', '10', 'ng/mL', '30-400'), mk('Vitamin D', '45', 'ng/mL', '30-100')])];
  if (crp != null) p.push(panel('Inf', [mk('hs-CRP', String(crp), 'mg/L', '0-3')]));
  return extract.apply(null, p);
};
ok('P3 fires on Hb + MCV + ferritin all low', firedIn(grade(ironPanels(null)), 'BLOOD', 'P3'));
ok('P3 stands down when inflammation is present', !firedIn(grade(ironPanels(12)), 'BLOOD', 'P3'));
ok('P3b explains the ferritin caveat instead',
  firedIn(grade(ironPanels(12)), 'NUTRITIONAL', 'P3b'));

// P5b: a transaminase over 3x the upper limit is D.
const bigAlt = grade(extract(panel('L', [
  mk('SGPT', '140', 'U/L', '0-40'), mk('SGOT', '90', 'U/L', '0-40')
])));
ok('P5b fires above 3x the upper limit', firedIn(bigAlt, 'LIVER', 'P5b'));
eq('P5b forces liver to D', areaOf(bigAlt, 'LIVER').grade, 'D');

// P7 / P7b: filtration.
const egfr = (v) => grade(extract(panel('K', [
  mk('Serum Creatinine', '1.4', 'mg/dL', '0.7-1.3'),
  mk('eGFR', String(v), 'mL/min', '90-120')
])));
ok('P7 fires below 60', firedIn(egfr(52), 'KIDNEY', 'P7'));
ok('P7 does not fire at 60', !firedIn(egfr(60), 'KIDNEY', 'P7'));
eq('P7b forces D below 30', areaOf(egfr(28), 'KIDNEY').grade, 'D');

// P8: an isolated TSH change is capped at C.
const isoTsh = grade(extract(panel('T', [
  mk('TSH', '7.5', 'uIU/mL', '0.45-4.5'), mk('Free T4', '1.1', 'ng/dL', '0.82-1.77')
])));
ok('P8 fires on TSH out with T4 in', firedIn(isoTsh, 'THYROID', 'P8'));
eq('P8 caps an isolated TSH change at C', areaOf(isoTsh, 'THYROID').grade, 'C');

// The cap must stand down when the marker is at a panic level.
const bigTsh = grade(extract(panel('T', [
  mk('TSH', '18', 'uIU/mL', '0.45-4.5'), mk('Free T4', '1.1', 'ng/dL', '0.82-1.77')
])));
eq('the P8 cap does not hide a panic-level TSH', areaOf(bigTsh, 'THYROID').grade, 'D');

// P9 / P10: diabetic vs pre-diabetic ranges.
const a1c = (v) => grade(extract(panel('M', [mk('HbA1c', String(v), '%', '4.0-9.0')])));
eq('HbA1c 6.5 is D', areaOf(a1c(6.5), 'METABOLIC').grade, 'D');
ok('HbA1c 6.0 is not D', areaOf(a1c(6.0), 'METABOLIC').grade !== 'D');
ok('P10 fires in the pre-diabetic band', firedIn(a1c(6.0), 'METABOLIC', 'P10'));

// ===========================================================================
section('grading — determinism');
// ===========================================================================

const detExtract = extract(lipids(158, 34, 268, 238),
  panel('M', [mk('HbA1c', '6.1', '%', '4.0-5.6')]),
  panel('C', [mk('Haemoglobin', '11.2', 'g/dL', '13.0-17.0'), mk('MCV', '74', 'fL', '80-100'),
    mk('Platelet Count', '240', 'K/uL', '150-410')]));
const runs = [];
for (let i = 0; i < 50; i += 1) {
  const r = grade(detExtract);
  runs.push(JSON.stringify(r.areas.map((a) => [a.areaId, a.grade, a.score, a.gradeRationale])));
}
eq('50 runs produce identical grades and rationale', new Set(runs).size, 1);

const everyArea = grade(detExtract);
everyArea.areas.forEach((a) => {
  ok(`${a.areaId} carries a rationale`, Array.isArray(a.gradeRationale) && a.gradeRationale.length > 0);
  ok(`${a.areaId} rationale ends with the final grade`,
    a.grade === 'NOT_ASSESSED' || a.gradeRationale[a.gradeRationale.length - 1] === `FINAL=${a.grade}`);
});

// ===========================================================================
section('comparison — trends');
// ===========================================================================

function trendOf(curMk, prevMk, sex) {
  const cur = classify.classifyMarker(curMk, { sex: sex || 'male' });
  const prev = prevMk ? classify.classifyMarker(prevMk, { sex: sex || 'male' }) : null;
  return comparison.compareMarker(cur, prev);
}

// LDL: threshold is >= 10 mg/dL AND >= 10 %.
eq('LDL 182 -> 158 is an improvement',
  trendOf(mk('LDL Cholesterol', '158', 'mg/dL', '0-100'), mk('LDL Cholesterol', '182', 'mg/dL', '0-100')).trend,
  TREND.IMPROVED);
eq('LDL 170 -> 160 clears the absolute bar but not the percentage bar',
  trendOf(mk('LDL Cholesterol', '160', 'mg/dL', '0-100'), mk('LDL Cholesterol', '170', 'mg/dL', '0-100')).trend,
  TREND.STABLE);
// Crossing the panic bound changes the status without the number moving much. That
// is deliberately NOT reported as an improvement — the client is still above range.
eq('LDL 200 -> 190 crosses a bound but is not an improvement',
  trendOf(mk('LDL Cholesterol', '190', 'mg/dL', '0-100'), mk('LDL Cholesterol', '200', 'mg/dL', '0-100')).trend,
  TREND.NO_SIGNIFICANT_CHANGE);
eq('LDL 142 -> 158 needs attention',
  trendOf(mk('LDL Cholesterol', '158', 'mg/dL', '0-100'), mk('LDL Cholesterol', '142', 'mg/dL', '0-100')).trend,
  TREND.NEEDS_ATTENTION);
eq('an identical value is stable',
  trendOf(mk('LDL Cholesterol', '142', 'mg/dL', '0-100'), mk('LDL Cholesterol', '142', 'mg/dL', '0-100')).trend,
  TREND.STABLE);

// Direction is per marker: a fall in HDL is not an improvement.
eq('HDL falling is not an improvement',
  trendOf(mk('HDL Cholesterol', '38', 'mg/dL', '40-60'), mk('HDL Cholesterol', '46', 'mg/dL', '40-60')).trend,
  TREND.NEW_FINDING);
eq('HDL rising within range is an improvement',
  trendOf(mk('HDL Cholesterol', '58', 'mg/dL', '40-60'), mk('HDL Cholesterol', '46', 'mg/dL', '40-60')).trend,
  TREND.IMPROVED);

// Boundary crossings.
eq('within range -> out of range is a new finding',
  trendOf(mk('SGPT', '55', 'U/L', '0-40'), mk('SGPT', '30', 'U/L', '0-40')).trend, TREND.NEW_FINDING);
eq('a boundary crossing records why it is new',
  trendOf(mk('SGPT', '55', 'U/L', '0-40'), mk('SGPT', '30', 'U/L', '0-40')).newReason, 'MOVED_OUT_OF_RANGE');
eq('out of range -> within range is resolved',
  trendOf(mk('SGPT', '30', 'U/L', '0-40'), mk('SGPT', '55', 'U/L', '0-40')).trend, TREND.RESOLVED);
eq('a newly measured abnormal marker is a new finding',
  trendOf(mk('SGPT', '55', 'U/L', '0-40'), null).trend, TREND.NEW_FINDING);
eq('a newly measured abnormal marker records why',
  trendOf(mk('SGPT', '55', 'U/L', '0-40'), null).newReason, 'FIRST_MEASURED');
eq('a newly measured normal marker says nothing',
  trendOf(mk('SGPT', '30', 'U/L', '0-40'), null).trend, TREND.NOT_COMPARABLE);

// Units.
eq('mmol/L vs mg/dL compares after conversion',
  trendOf(mk('LDL Cholesterol', '158', 'mg/dL', '0-100'), mk('LDL Cholesterol', '4.7', 'mmol/L', '0-2.6')).trend,
  TREND.IMPROVED);
eq('an unreconcilable unit is not comparable',
  trendOf(mk('Novel Assay', '5', 'widgets', ''), mk('Novel Assay', '9', 'sprockets', '')).trend,
  TREND.NOT_COMPARABLE);
eq('no previous value is not comparable, never invented',
  trendOf(mk('LDL Cholesterol', '90', 'mg/dL', '0-100'), null).previous, null);

// A status flip driven by a boundary, not by real movement. Ferritin 29 -> 31 steps
// just inside the range but lands in the borderline band, so it is still flagged.
// Calling that "Resolved" would tell a client their iron stores recovered on a
// 2 ng/mL move; the engine must not.
const flip = trendOf(mk('Ferritin', '31', 'ng/mL', '30-400'), mk('Ferritin', '29', 'ng/mL', '30-400'));
eq('a 2-unit step across a boundary is not called Resolved', flip.trend, TREND.NO_SIGNIFICANT_CHANGE);
// A genuine return to well inside the range is Resolved.
eq('a real return to range is Resolved',
  trendOf(mk('Ferritin', '120', 'ng/mL', '30-400'), mk('Ferritin', '18', 'ng/mL', '30-400')).trend,
  TREND.RESOLVED);

// Interval.
eq('interval in days', comparison.daysBetween('2026-03-04', '2026-09-02'), 182);
ok('a short interval is flagged', comparison.buildProgress(
  { areas: [], classified: { byId: new Map() }, date: '2026-09-02' },
  { areas: [], classified: { byId: new Map() }, date: '2026-08-20' }
).shortInterval);

// ===========================================================================
section('priority');
// ===========================================================================

const bigReport = buildGradedHealthReport({
  extracted: extract(
    lipids(158, 34, 268, 238),
    panel('M', [mk('HbA1c', '6.1', '%', '4.0-5.6')]),
    panel('C', [mk('Haemoglobin', '11.2', 'g/dL', '13.0-17.0'), mk('MCV', '74', 'fL', '80-100'),
      mk('Platelet Count', '240', 'K/uL', '150-410'), mk('Total Leucocyte Count', '7.0', 'K/uL', '4.0-11.0')]),
    panel('N', [mk('Ferritin', '11', 'ng/mL', '30-400'), mk('Vitamin D', '14', 'ng/mL', '30-100')])
  ),
  client: { name: 'Test', sex: 'male' },
  screeningDate: '2026-09-02',
  reportId: 't1'
});

ok('at most three priorities', bigReport.priorities.length <= 3);
eq('ranks are 1..n', bigReport.priorities.map((p) => p.rank).join(','),
  bigReport.priorities.map((_, i) => i + 1).join(','));

const priorityGroups = bigReport.priorities.map((p) => registry.getMarker(p.markerId).group);
eq('no two priorities from one correlation group',
  new Set(priorityGroups).size, priorityGroups.length);

const priorityAreas = {};
bigReport.priorities.forEach((p) => { priorityAreas[p.areaId] = (priorityAreas[p.areaId] || 0) + 1; });
ok('no more than two priorities from one area when others qualify',
  Object.keys(priorityAreas).every((k) => priorityAreas[k] <= 2),
  JSON.stringify(priorityAreas));

const dGrades = bigReport.priorities.filter((p) => p.grade === 'D');
if (dGrades.length) {
  eq('grade D priorities come first', bigReport.priorities[0].grade, 'D');
  bigReport.priorities.forEach((p) => {
    if (p.grade === 'D') {
      eq(`${p.markerId} D priority requires a professional`, p.requiresProfessional, true);
      ok(`${p.markerId} D priority still carries an action`, !!p.nextStep);
      ok(`${p.markerId} D priority action is not just the referral`,
        p.nextStep !== copy.PROFESSIONAL_LINE);
    }
  });
}

// No padding on a clean report.
const cleanReport = buildGradedHealthReport({
  extracted: extract(lipids(80, 55, 110, 170)),
  client: { name: 'Test', sex: 'male' }, screeningDate: '2026-09-02', reportId: 't2'
});
eq('a clean report has no priorities', cleanReport.priorities.length, 0);
eq('a clean report still has next steps', cleanReport.nextSteps.length > 0, true);

// One finding produces one card, not three.
const oneFinding = buildGradedHealthReport({
  extracted: extract(lipids(142, 55, 110)),
  client: { name: 'Test', sex: 'male' }, screeningDate: '2026-09-02', reportId: 't3'
});
eq('one qualifying finding produces one priority', oneFinding.priorities.length, 1);

// Determinism of ordering.
const orders = [];
for (let i = 0; i < 20; i += 1) {
  orders.push(buildGradedHealthReport({
    extracted: extract(lipids(158, 34, 268, 238),
      panel('N', [mk('Ferritin', '11', 'ng/mL', '30-400'), mk('Vitamin D', '14', 'ng/mL', '30-100')])),
    client: { name: 'Test', sex: 'male' }, screeningDate: '2026-09-02', reportId: 't4'
  }).priorities.map((p) => p.markerId).join(','));
}
eq('priority order is stable across renders', new Set(orders).size, 1);

// ===========================================================================
section('medical safety');
// ===========================================================================

// Phrases that must never appear in anything a client reads.
const PROHIBITED = [
  /\byou have (?:a |an )?(?:diabetes|disease|condition|disorder|anaemia|anemia|cancer)\b/i,
  /\bthis indicates\b/i,
  // The ban is on CLAIMING a diagnosis, not on the word itself — the disclaimer has
  // to be able to say "not a medical diagnosis", which is the opposite of a claim.
  /\b(?:diagnosed with|the diagnosis is|is diagnostic of|confirms? (?:a )?diagnosis)\b/i,
  /\byour (?:liver|kidney|heart|thyroid) is (?:healthy|fine|normal|damaged|failing)\b/i,
  /\bnothing to worry about\b/i,
  /\bdangerous\b/i,
  /\bcritical\b/i,
  /\babnormal\b/i,
  /\bnormal\b/i
];
const PROHIBITED_LABEL = [
  'you have <condition>', '"this indicates"', 'a claimed diagnosis', 'organ-level absolute',
  '"nothing to worry about"', '"dangerous"', '"critical"', '"abnormal"', '"normal"'
];

/** Walk every client-visible string in a report. */
function clientStrings(report) {
  const out = [];
  const skipKeys = new Set([
    'gradeRationale',   // machine-readable audit trail, surfaced only on demand to staff
    'markerId', 'areaId', 'status', 'trend', 'statusSource', 'newReason',
    'engineVersion', 'rulesetVersion', 'modelVersion', 'variant', 'reportId',
    'printedName', 'panelName', 'unit', 'clinical', 'source', 'statusMark'
  ]);
  const walk = (node, path) => {
    if (node == null) return;
    if (typeof node === 'string') { out.push({ path, text: node }); return; }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (typeof node === 'object') {
      Object.keys(node).forEach((k) => {
        if (skipKeys.has(k)) return;
        walk(node[k], path ? `${path}.${k}` : k);
      });
    }
  };
  walk(report, '');
  return out;
}

[bigReport, cleanReport, oneFinding].forEach((r, ri) => {
  clientStrings(r).forEach((s) => {
    PROHIBITED.forEach((re, i) => {
      ok(`report ${ri} · ${s.path}: no ${PROHIBITED_LABEL[i]}`, !re.test(s.text),
        `"${s.text.slice(0, 120)}"`);
    });
  });
});

// Every marker copy entry, directly.
Object.keys(copy.MARKER_COPY).forEach((id) => {
  const entry = copy.MARKER_COPY[id];
  ['what', 'high', 'low', 'act'].forEach((k) => {
    if (!entry[k]) return;
    PROHIBITED.forEach((re, i) => {
      ok(`MARKER_COPY.${id}.${k}: no ${PROHIBITED_LABEL[i]}`, !re.test(entry[k]),
        `"${entry[k].slice(0, 100)}"`);
    });
  });
});

// Status labels must not use the forbidden vocabulary.
Object.keys(copy.STATUS_LABEL).forEach((k) => {
  ok(`STATUS_LABEL.${k} avoids "critical"/"normal"/"abnormal"`,
    !/critical|abnormal|\bnormal\b/i.test(copy.STATUS_LABEL[k]), copy.STATUS_LABEL[k]);
});

// The RESULT and STATUS layers must be machine-derived, never model prose.
[bigReport, cleanReport, oneFinding].forEach((r, ri) => {
  r.markerGroups.forEach((g) => {
    g.markers.forEach((m) => {
      ok(`report ${ri} · ${g.label}/${m.displayName}: status is a known enum`,
        Object.prototype.hasOwnProperty.call(STATUS, m.status), m.status);
      ok(`report ${ri} · ${g.label}/${m.displayName}: status label is from the fixed set`,
        Object.keys(copy.STATUS_LABEL).map((k) => copy.STATUS_LABEL[k]).indexOf(m.statusLabel) >= 0,
        m.statusLabel);
      ok(`report ${ri} · ${g.label}/${m.displayName}: statusSource is declared`,
        ['DERIVED_LAB', 'DERIVED_PREFERRED', 'EXTRACTED'].indexOf(m.statusSource) >= 0, m.statusSource);
      // A row graded on a BodyBank range must say so.
      if (m.range.source === 'BODYBANK_PREFERRED') {
        eq(`${m.displayName}: BodyBank range is labelled`, m.range.label, 'BodyBank preferred range');
      }
    });
  });
});

// The disclaimer is always present, on every report.
[bigReport, cleanReport, oneFinding].forEach((r, i) => {
  ok(`report ${i} carries the disclaimer`, !!r.disclaimer && r.disclaimer.length > 100);
  ok(`report ${i} disclaimer says it is not a diagnosis`, /not a medical diagnosis/i.test(r.disclaimer));
  ok(`report ${i} disclaimer points to a professional`, /healthcare professional/i.test(r.disclaimer));
  ok(`report ${i} stamps the engine version`, !!r.engineVersion);
  ok(`report ${i} stamps the ruleset version`, !!r.rulesetVersion);
});

// Grade D must always route to a professional.
bigReport.areas.forEach((a) => {
  if (a.grade !== 'D') return;
  eq(`${a.areaId} grade D requires a professional`, a.requiresProfessional, true);
});
if (bigReport.areas.some((a) => a.grade === 'D')) {
  ok('a grade D report opens its next steps with a referral',
    /healthcare professional/i.test(bigReport.nextSteps[0].text));
}

// Nothing is silently dropped: every extracted row reaches the table.
// lipids() emits LDL + HDL + TG + TC = 4, then HbA1c(1), CBC(4), nutrition(2).
const inputRowCount = 4 + 1 + 4 + 2;
eq('every extracted marker reaches the detailed table',
  bigReport.markerGroups.reduce((n, g) => n + g.markers.length, 0), inputRowCount);

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`FAILED  ${failures.length} of ${passed + failures.length} checks`);
  failures.slice(0, 40).forEach((f) => console.log('  ✗ ' + f));
  if (failures.length > 40) console.log(`  … and ${failures.length - 40} more`);
  process.exit(1);
}
console.log(`PASSED  ${passed} checks — graded report engines`);
