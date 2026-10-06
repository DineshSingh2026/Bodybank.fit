'use strict';

/**
 * BodyBank — HEALTH MAP 360 tests.  Run: node tests/complete-report.js
 *
 * Covers the calculated indices, the cross-marker patterns, the personal layer, the
 * document (and its promise not to alter the standard Health Map), and the
 * sign-off rules in the service. No network, no database: the service runs against
 * an in-memory stub.
 */

const fs = require('fs');
const path = require('path');

const { buildGradedHealthReport } = require('../services/gradedHealthReport');
const gradedDoc = require('../services/gradedReportDocument');
const completeDoc = require('../services/completeReportDocument');
const insights = require('../services/complete/insights');
const personal = require('../services/complete/personal');
const service = require('../services/gradedReportService');

let passed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed += 1; return; }
  failures.push(label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
}
function near(a, b, tol) { return Math.abs(Number(a) - b) <= (tol == null ? 0.051 : tol); }

const FIX = path.join(__dirname, '..', 'fixtures', 'demo');
const cur = JSON.parse(fs.readFileSync(path.join(FIX, 'screening-current.json'), 'utf8'));
const report = buildGradedHealthReport({
  extracted: cur.extracted, previous: null, client: cur.client,
  screeningDate: cur.extracted.report_date, reportId: 'test'
});

/** A report holding exactly the markers given: [[name, value, unit, range]]. */
function reportOf(markers, client) {
  return buildGradedHealthReport({
    extracted: { panels: [{ panel_name: 'Panel', markers: markers.map((m) => ({ name: m[0], value: String(m[1]), unit: m[2], reference_range: m[3] || '' })) }] },
    client: client || { name: 'T', age: '40', sex: 'male' }, screeningDate: '2026-09-01', reportId: 't'
  });
}
const idx = (list, key) => list.filter((i) => i.key === key)[0] || null;

// ── 1. calculated indices: the arithmetic ────────────────────────────────────
(function indices() {
  const r = reportOf([
    ['Triglycerides', 268, 'mg/dL', '0-150'], ['HDL Cholesterol', 34, 'mg/dL', '40-60'],
    ['LDL Cholesterol', 158, 'mg/dL', '0-100'], ['Total Cholesterol', 238, 'mg/dL', '0-200'],
    ['HbA1c', 6.1, '%', '4-5.6'], ['Fasting Glucose', 112, 'mg/dL', '70-99'], ['Fasting Insulin', 14, 'µIU/mL', '2-25'],
    ['Creatinine', 1.0, 'mg/dL', '0.7-1.3'], ['ALT', 62, 'U/L', '0-40'], ['AST', 48, 'U/L', '0-40'],
    ['Platelet Count', 240, 'K/µL', '150-410'], ['Neutrophils', 60, '%', '40-75'], ['Lymphocytes', 30, '%', '20-45'],
    ['MCV', 74, 'fL', '80-100'], ['RBC Count', 4.1, 'mill/µL', '4.5-5.9'],
    ['Calcium', 8.6, 'mg/dL', '8.5-10.5'], ['Albumin', 3.5, 'g/dL', '3.5-5.2']
  ], { name: 'T', age: '41', sex: 'male' });
  const list = insights.buildIndices(r, { age: 41, sex: 'male', fasting: 'yes', heightCm: 174, weightKg: 82 });
  ok(near(idx(list, 'TG_HDL').result, 268 / 34), 'TG/HDL = 7.9', idx(list, 'TG_HDL'));
  ok(idx(list, 'TG_HDL').level === insights.LEVEL.FLAG, 'TG/HDL above 3 is flagged');
  ok(idx(list, 'NON_HDL').result === '204 mg/dL', 'non-HDL = total - HDL');
  ok(near(idx(list, 'TC_HDL').result, 7.0), 'TC/HDL = 7.0');
  ok(idx(list, 'REMNANT').result === '46 mg/dL', 'remnant = total - HDL - LDL');
  ok(idx(list, 'EAG').result === '128 mg/dL', 'eAG from HbA1c 6.1 = 128', idx(list, 'EAG'));
  ok(near(idx(list, 'HOMA_IR').result, (112 * 14) / 405), 'HOMA-IR = glucose x insulin / 405');
  // CKD-EPI 2021, male, 41y, creatinine 1.0 → 142 * (1/0.9)^-1.2 * 0.9938^41 ≈ 96.9
  ok(near(parseFloat(idx(list, 'EGFR').result), 97, 1.01), 'eGFR by CKD-EPI 2021', idx(list, 'EGFR'));
  ok(near(idx(list, 'AST_ALT').result, 48 / 62, 0.006), 'AST/ALT ratio');
  ok(near(idx(list, 'FIB4').result, (41 * 48) / (240 * Math.sqrt(62)), 0.006), 'FIB-4');
  ok(near(idx(list, 'NLR').result, 2.0), 'NLR');
  ok(near(idx(list, 'MENTZER').result, 74 / 4.1), 'Mentzer index only when MCV is low');
  ok(idx(list, 'CORR_CA').result === '9.0 mg/dL', 'corrected calcium', idx(list, 'CORR_CA'));
  ok(near(idx(list, 'BMI').result, 82 / (1.74 * 1.74)), 'BMI');
  ok(idx(list, 'BMI').level === insights.LEVEL.FLAG, 'BMI 27 is above the Asian Indian range');

  // Never guess: an unknown unit, a missing input or a non-fasting sample leaves the index out.
  const odd = reportOf([['Triglycerides', 3.0, 'furlongs', ''], ['HDL Cholesterol', 34, 'mg/dL', '40-60']]);
  ok(!idx(insights.buildIndices(odd, {}), 'TG_HDL'), 'unknown unit → no ratio');
  ok(!idx(insights.buildIndices(r, { age: 41, sex: 'male', fasting: 'no' }), 'HOMA_IR'), 'non-fasting sample → no HOMA-IR');
  ok(!idx(insights.buildIndices(r, { fasting: 'yes' }), 'EGFR'), 'no age or sex → no eGFR');
  ok(!idx(insights.buildIndices(r, { age: 41, sex: 'male' }), 'BMI'), 'no height or weight → no BMI');
  const mmol = reportOf([['Triglycerides', 3.03, 'mmol/L', '0-1.7'], ['HDL Cholesterol', 0.88, 'mmol/L', '1.0-1.6']]);
  const conv = idx(insights.buildIndices(mmol, {}), 'TG_HDL');
  ok(conv && near(conv.result, 268 / 34, 0.3), 'mmol/L inputs are converted before the ratio', conv);
  const reported = reportOf([['Total Cholesterol', 238, 'mg/dL', ''], ['HDL Cholesterol', 34, 'mg/dL', ''], ['Non-HDL Cholesterol', 204, 'mg/dL', '']]);
  ok(!idx(insights.buildIndices(reported, {}), 'NON_HDL'), 'an index the lab already printed is not recalculated');
  ok(insights.buildIndices(reportOf([]), {}).length === 0, 'empty report → no indices');
})();

// ── 2. patterns ──────────────────────────────────────────────────────────────
(function patterns() {
  const { indices, patterns } = insights.buildInsights(report, { age: 41, sex: 'male' });
  const keys = patterns.map((p) => p.key);
  ok(keys.indexOf('IRON_DEFICIENCY') >= 0, 'fixture: low Hb + small cells + low ferritin → iron deficiency pattern', keys);
  ok(keys.indexOf('INSULIN_RESISTANCE') >= 0, 'fixture: high TG + low HDL + raised sugar → insulin resistance pattern');
  ok(keys.indexOf('PREDIABETES_RANGE') >= 0 && keys.indexOf('DIABETES_RANGE') < 0, 'HbA1c 6.1 is prediabetes range, not diabetes range');
  ok(patterns.every((p) => p.title && p.meaning && p.action && p.evidence.length), 'every pattern has a title, evidence, meaning and action');
  ok(patterns.filter((p) => p.key === 'IRON_DEFICIENCY')[0].requiresProfessional, 'anaemia is flagged for a doctor');
  ok(indices.length > 0, 'fixture produces indices');

  const p = (markers, ctx) => insights.buildInsights(reportOf(markers), ctx || {}).patterns.map((x) => x.key);
  ok(p([['HbA1c', 7.2, '%', '4-5.6']]).indexOf('DIABETES_RANGE') >= 0, 'HbA1c 7.2 → diabetes range');
  ok(p([['Hemoglobin', 11, 'g/dL', '13-17'], ['MCV', 108, 'fL', '80-100']]).indexOf('MACROCYTIC') >= 0, 'low Hb + large cells → B12/folate pattern');
  ok(p([['Hemoglobin', 14.5, 'g/dL', '13-17'], ['Ferritin', 9, 'ng/mL', '30-400']]).indexOf('LOW_IRON_STORES') >= 0, 'low ferritin, normal Hb → low stores');
  ok(p([['TSH', 9, 'µIU/mL', '0.4-4.5'], ['Free T4', 0.5, 'ng/dL', '0.8-1.8']]).indexOf('THYROID') >= 0, 'high TSH + low T4 → thyroid pattern');
  ok(p([['LDL Cholesterol', 200, 'mg/dL', '0-100']]).indexOf('ATHEROGENIC_LIPIDS') >= 0, 'LDL 200 → lipid pattern');
  ok(p([['Vitamin D (25-OH)', 12, 'ng/mL', '30-100']]).indexOf('LOW_VITAMIN_D') >= 0, 'vitamin D 12 → deficiency');
  ok(p([['Uric Acid', 9, 'mg/dL', '3.5-7.2']]).indexOf('URIC_ACID') >= 0, 'raised uric acid');
  const healthy = [['Hemoglobin', 15, 'g/dL', '13-17'], ['LDL Cholesterol', 80, 'mg/dL', '0-100'], ['HbA1c', 5.2, '%', '4-5.6'],
    ['TSH', 2, 'µIU/mL', '0.4-4.5'], ['Vitamin D (25-OH)', 45, 'ng/mL', '30-100']];
  ok(p(healthy).length === 0, 'a healthy panel produces no patterns', p(healthy));
  const onThyroid = insights.buildInsights(reportOf([['TSH', 9, 'µIU/mL', '0.4-4.5']]), { medicines: ['THYROID_MED'] }).patterns[0];
  ok(/dose/.test(onThyroid.meaning) && /Do not change the dose/.test(onThyroid.action), 'thyroid pattern is reworded for someone on thyroid medicine');
})();

// ── 3. the personal layer ────────────────────────────────────────────────────
(function personalLayer() {
  const c = personal.normalizeContext({
    goal: 'Lose fat', medicines: 'Thyronorm 50, creatine, whey', conditions: 'Thyroid, father has diabetes and mother had a heart attack',
    diet: 'VEG', activity: 'moderate', alcohol: 'weekly', smoking: 'nonsense', fasting: 'yes',
    familyHistory: ['bp', 'made-up'], symptoms: 'fatigue,hairfall,unknown', heightCm: '174', weightKg: '82.4', age: '41', sex: 'Male'
  });
  ok(c.goalKey === 'FAT_LOSS', 'goal recognised');
  ok(c.medicines.join() === 'THYROID_MED,CREATINE,PROTEIN', 'medicines recognised', c.medicines);
  ok(c.conditions.join() === 'THYROID', "a relative's diabetes is NOT the client's condition", c.conditions);
  ok(c.familyHistory.indexOf('diabetes') >= 0 && c.familyHistory.indexOf('heart') >= 0 && c.familyHistory.indexOf('bp') >= 0,
    'relatives in the conditions box become family history', c.familyHistory);
  ok(c.familyHistory.indexOf('made-up') < 0 && c.symptoms.join() === 'fatigue,hairfall', 'unknown choices are dropped');
  ok(c.diet === 'veg' && c.smoking === '' && c.heightCm === 174 && c.weightKg === 82.4 && c.sex === 'male' && c.age === 41, 'answers normalised');
  const empty = personal.normalizeContext({ medicines: 'none', conditions: 'No' });
  ok(!personal.hasPersonalDetail(empty) && !empty.medicinesText && !empty.conditionsText, '"none" and "no" count as no answer');
  ok(personal.normalizeContext({ heightCm: 900, weightKg: 3 }).heightCm === null, 'impossible height and weight are dropped');

  const goal = personal.buildGoalSection(report, c);
  ok(goal && goal.items.length > 0 && /Lose fat/.test(goal.subtitle), 'goal section quotes the goal');
  ok(/grade D/.test(goal.items[0].text), 'goal section leads with what is holding the client back');
  const notes = personal.buildContextNotes(report, c);
  ok(notes && notes.items.some((i) => /thyroid medicine/.test(i.text)) && notes.items.some((i) => /creatine/.test(i.text)), 'medicine notes present');
  ok(notes.items.some((i) => /family history/.test(i.text)), 'family history note present');
  ok(personal.buildContextNotes(report, personal.normalizeContext({})) === null, 'no answers → no "what you told us" section');

  const { patterns } = insights.buildInsights(report, c);
  const plan = personal.buildNutritionPlan(report, c, patterns);
  ok(plan.add.length && plan.limit.length && plan.day.length === 6 && plan.weeks.length === 4, 'plan has foods, a day and four weeks');
  const all = JSON.stringify(plan).toLowerCase();
  ok(!/chicken|fish|mutton|egg/.test(all), 'a vegetarian plan names no meat, fish or eggs', all.match(/chicken|fish|mutton|egg/));
  // Every theme at once, so each food line is exercised for each diet.
  const everything = ['IRON', 'B12', 'LDL', 'TRIGLYCERIDES', 'HDL', 'GLUCOSE', 'LIVER', 'VITAMIN_D', 'THYROID', 'URIC_ACID', 'KIDNEY', 'INFLAMMATION']
    .map((f) => ({ level: 2, focus: [f] }));
  const planFor = (diet) => {
    const parts = [];
    for (let i = 0; i < everything.length; i += 5) {
      parts.push(JSON.stringify(personal.buildNutritionPlan(reportOf([]), personal.normalizeContext({ diet }), everything.slice(i, i + 5))));
    }
    return parts.join(' ').toLowerCase();
  };
  const animal = /chicken|fish|mutton|\bmeat|\begg|liver once|shellfish|sardine|salmon/;
  ok(!animal.test(planFor('veg')), 'vegetarian plan: no meat, fish or eggs in any theme', planFor('veg').match(animal));
  ok(!animal.test(planFor('vegan')), 'vegan plan: no meat, fish or eggs in any theme', planFor('vegan').match(animal));
  const dairy = /paneer|curd|\bmilk|cheese|\bghee|butter|\bcream/;
  const veganText = planFor('vegan').replace(/soy milk|coconut cream/g, '');
  ok(!dairy.test(veganText), 'vegan plan: no dairy in any theme', veganText.match(dairy));
  ok(/fish|egg|chicken/.test(planFor('nonveg')), 'non-vegetarian plan does use them');
  ok(!/\b\d+\s?(mg|mcg|iu)\b/i.test(JSON.stringify(plan.supplements)), 'supplements carry no doses');
  const healthyPlan = personal.buildNutritionPlan(reportOf([['Hemoglobin', 15, 'g/dL', '13-17']]), personal.normalizeContext({}), []);
  ok(healthyPlan.add.length && healthyPlan.weeks.length === 4 && !healthyPlan.supplements.length, 'a healthy report still gets a maintenance plan');

  const retest = personal.buildRetestPlan(report, c, patterns);
  ok(retest.items.length >= 3 && retest.items.some((i) => /12 weeks/.test(i.text)), 'retest plan has timed items');
  const q = personal.buildQuestions(report, c, patterns);
  ok(q.items.length >= 5 && q.items.length <= 8, 'five to eight questions', q.items.length);
  ok(typeof personal.buildSummaryDraft(report, c, patterns) === 'string', 'summary draft is text');
})();

// ── 4. the document ──────────────────────────────────────────────────────────
(function documentLayer() {
  const ctx = { goal: 'Lose fat', medicines: 'Thyronorm', diet: 'veg', familyHistory: ['diabetes'] };
  const doc = completeDoc.buildCompleteDoc(report, ctx, { doctor: { name: 'Dr. A', qualification: 'MBBS', regNo: 'R1' } });
  const std = gradedDoc.buildGradedDoc(report, {});

  // The promise: the standard Health Map sections arrive unaltered.
  const strip = (s) => JSON.stringify(s, (k, v) => (k === 'id' ? undefined : v));
  const types = ['healthmap', 'priorities', 'areacards', 'markers', 'disclaimer'];
  types.forEach((t) => {
    const a = std.sections.filter((s) => s.type === t).map(strip).join('|');
    const b = doc.sections.filter((s) => s.type === t).map(strip).join('|');
    ok(a === b && a.length > 0, `standard "${t}" section passes through unaltered`);
  });
  const stdLists = std.sections.filter((s) => s.type === 'list').map(strip);
  ok(stdLists.every((x) => doc.sections.filter((s) => s.type === 'list').map(strip).indexOf(x) >= 0), 'standard next steps pass through unaltered');
  ok(doc.cover.title === 'BodyBank Health Map 360 Report' && std.cover.title === 'BodyBank Health Map Report', 'titles differ; the standard title is untouched');
  ok(doc.edition === 'complete', 'edition marked');

  const titles = doc.sections.map((s) => s.title);
  ["Doctor's Summary", 'Reading Your Results Together', 'What This Means for Your Goal', 'Your Nutrition Plan', 'Foods to Add',
    'Your Four-Week Focus', 'Your Retest Plan', 'Questions for Your Doctor Call'].forEach((t) => ok(titles.indexOf(t) >= 0, `has section "${t}"`));
  const consult = doc.sections.filter((s) => /Consultation Summary/.test(s.title));
  ok(consult.length === 2 && consult.every((s) => s.show === false), 'both consultation summaries exist and start hidden');
  ok(doc.sections[doc.sections.length - 1].type === 'disclaimer', 'disclaimer is last');
  ok(doc.sections.filter((s) => s.type === 'signoff').length === 1, 'exactly one sign-off');
  ok(!completeDoc.isSigned(doc), 'a new document is unsigned');

  // Sanitising: idempotent, tolerant, and locked where it must be.
  const once = completeDoc.sanitizeCompleteDoc(doc);
  const twice = completeDoc.sanitizeCompleteDoc(JSON.parse(JSON.stringify(once)));
  ok(JSON.stringify(once) === JSON.stringify(twice), 'sanitise is idempotent');
  ok(once.sections.length === doc.sections.length, 'sanitise keeps every section', [once.sections.length, doc.sections.length]);
  const junk = completeDoc.sanitizeCompleteDoc({ sections: [{ type: 'evil' }, null, 5, { type: 'insights', rows: 'x' }, { type: 'signoff', signed: 'yes' }, { type: 'signoff', signed: true }] });
  ok(junk.sections.filter((s) => s.type === 'evil').length === 0, 'unknown section types are dropped');
  ok(junk.sections.filter((s) => s.type === 'signoff').length === 1 && junk.sections.filter((s) => s.type === 'signoff')[0].signed === false, 'one sign-off, and only a real boolean signs it');
  ok(junk.sections.some((s) => s.type === 'disclaimer'), 'a document without a disclaimer gets one back');
  ok(completeDoc.sanitizeCompleteDoc(null).sections.length === 1, 'null input → disclaimer only');
  const tampered = JSON.parse(JSON.stringify(once));
  const idxSec = tampered.sections.filter((s) => s.type === 'insights')[0];
  idxSec.rows[0].level = 99; idxSec.rows[0].label = 'x'.repeat(5000);
  const cleaned = completeDoc.sanitizeCompleteDoc(tampered).sections.filter((s) => s.type === 'insights')[0];
  ok(cleaned.rows[0].level === insights.LEVEL.INFO && cleaned.rows[0].label.length === 160, 'row fields are bounded');

  // No personal answers at all: the report still builds, without the personal sections.
  const bare = completeDoc.buildCompleteDoc(report, {}, {});
  ok(bare.sections.every((s) => s.title !== 'What You Told Us, and How It Changes the Reading'), 'no answers → no "what you told us"');
  ok(bare.sections.some((s) => s.title === 'Your Nutrition Plan'), 'no answers → still a plan');
  const emptyRep = completeDoc.sanitizeCompleteDoc(completeDoc.buildCompleteDoc(reportOf([]), {}, {}));
  ok(emptyRep.sections.every((s) => s.type !== 'insights'), 'no markers → no empty "results together" section');
})();

// ── 5. the service: storage and the sign-off rules ───────────────────────────
function stubDb(row, doctor) {
  const db = {
    row, doctor,
    async queryOne(sql) {
      if (/FROM bloodmap_consultants/.test(sql)) return db.doctor;
      if (/FROM bloodmap_orders/.test(sql)) return { intake: { goal: 'Lose fat', diet: 'veg' }, age: '41', gender: 'male' };
      if (/FROM users/.test(sql)) return { first_name: 'Demo', last_name: 'Client', goal_type: '', diet_type: '', height_cm: null, gender: 'male' };
      if (/FROM blood_analysis_reports/.test(sql)) return db.row;
      return null;
    },
    async queryAll() { return []; },
    async run(sql, params) {
      if (/SET complete_doc = \?::jsonb/.test(sql)) {
        db.row.complete_doc = JSON.parse(params[0]); db.row.complete_doc_updated_by = params[1];
        db.row.complete_pdf_path = null; db.row.admin_notes = params[2];
      } else if (/SET complete_doc = NULL/.test(sql)) {
        db.row.complete_doc = null; db.row.complete_pdf_path = null;
      } else if (/SET graded_doc = \?::jsonb/.test(sql)) {
        db.row.graded_doc = JSON.parse(params[0]);
      } else if (/SET report_variant = \?/.test(sql)) {
        db.row.report_variant = params[0];
      } else if (/SET graded_report = \?::jsonb/.test(sql)) {
        db.row.graded_report = JSON.parse(params[0]);
      }
      return { rowCount: 1, rows: [] };
    }
  };
  return db;
}

async function serviceTests() {
  const fullDoctor = { name: 'Dr. A', qualification: 'MBBS, MD', reg_no: 'REG-1', signature: '' };
  const row = () => ({
    id: 'r1', user_id: 'u1', report_variant: 'complete', extracted_blood_data: cur.extracted, graded_report: null,
    graded_doc: null, complete_doc: null, user_name: 'Demo Client', user_age: '41', user_gender: 'male', user_goal: '',
    report_date: '2026-09-02', created_at: '2026-09-03T00:00:00Z', admin_notes: ''
  });

  ok(service.normalizeVariant('complete') === 'complete' && service.normalizeVariant('COMPLETE ') === 'complete', 'variant recognised');
  ok(service.normalizeVariant('nonsense') === 'classic', 'unknown variant still falls back to classic');
  ok(service.usesGradedEngine('complete') && service.usesGradedEngine('graded') && !service.usesGradedEngine('classic'), 'engine routing');

  let db = stubDb(row(), fullDoctor);
  let got = await service.getGradedDoc(db, 'r1');
  ok(got.doc && got.doc.edition === 'complete' && !got.edited, 'a complete-variant row yields the 360 document');
  ok(completeDoc.signoffOf(got.doc).doctorName === 'Dr. A' && completeDoc.signoffOf(got.doc).regNo === 'REG-1', "doctor's details come from the consultant record");
  ok((await service.deliveryStatus(db, 'r1')).signed === false, 'unsigned 360 report is not deliverable');

  // Signing: details and stamps are the server's, not the browser's.
  const forged = JSON.parse(JSON.stringify(got.doc));
  Object.assign(completeDoc.signoffOf(forged), { signed: true, doctorName: 'Dr. Fake', regNo: 'FAKE', signedAt: '1999-01-01', signedBy: 'nobody' });
  let saved = await service.saveGradedDoc(db, 'r1', forged, 'staff@bodybank.fit');
  const so = completeDoc.signoffOf(saved.doc);
  ok(so.signed && so.doctorName === 'Dr. A' && so.regNo === 'REG-1', "a forged doctor name or registration number is overwritten from the record", so);
  ok(so.signedBy === 'staff@bodybank.fit' && /^20\d\d-/.test(so.signedAt) && so.signedAt !== '1999-01-01', 'signing time and account are stamped by the server', so);
  ok(db.row.graded_doc === null, "saving a 360 document does not touch the Health Map's document");
  ok((await service.deliveryStatus(db, 'r1')).signed === true, 'signed 360 report is deliverable');

  const firstStamp = so.signedAt;
  const again = JSON.parse(JSON.stringify(saved.doc));
  again.sections.filter((s) => s.title === "Doctor's Summary")[0].body = 'Edited after signing.';
  saved = await service.saveGradedDoc(db, 'r1', again, 'someone-else@bodybank.fit');
  ok(completeDoc.signoffOf(saved.doc).signedAt === firstStamp && completeDoc.signoffOf(saved.doc).signedBy === 'staff@bodybank.fit', 'a later edit keeps the original signing stamp');
  ok(saved.doc.sections.filter((s) => s.title === "Doctor's Summary")[0].body === 'Edited after signing.', 'the edit itself is saved');

  const unsign = JSON.parse(JSON.stringify(saved.doc));
  completeDoc.signoffOf(unsign).signed = false;
  saved = await service.saveGradedDoc(db, 'r1', unsign, 'staff@bodybank.fit');
  ok(!completeDoc.isSigned(saved.doc) && completeDoc.signoffOf(saved.doc).signedAt === '', 'removing the sign-off clears the stamp');
  ok((await service.deliveryStatus(db, 'r1')).signed === false, 'and the report is no longer deliverable');

  // No complete doctor record → cannot sign.
  db = stubDb(row(), { name: 'Dr. A', qualification: 'MBBS', reg_no: '', signature: '' });
  got = await service.getGradedDoc(db, 'r1');
  const tryit = JSON.parse(JSON.stringify(got.doc));
  completeDoc.signoffOf(tryit).signed = true;
  const refused = await service.saveGradedDoc(db, 'r1', tryit, 'staff');
  ok(!!refused.error && /registration number/.test(refused.error) && db.row.complete_doc === null, 'signing is refused without a registration number on record', refused.error);
  db = stubDb(row(), null);
  const noDoc = JSON.parse(JSON.stringify((await service.getGradedDoc(db, 'r1')).doc));
  completeDoc.signoffOf(noDoc).signed = true;
  ok(!!(await service.saveGradedDoc(db, 'r1', noDoc, 'staff')).error, 'signing is refused when no doctor is set up');

  // Reset, and isolation from the other two variants.
  db = stubDb(row(), fullDoctor);
  await service.saveGradedDoc(db, 'r1', (await service.getGradedDoc(db, 'r1')).doc, 'staff');
  ok(db.row.complete_doc !== null, 'document stored');
  const reset = await service.resetGradedDoc(db, 'r1');
  ok(db.row.complete_doc === null && reset.doc && !reset.edited, 'reset returns to the generated 360 document');

  const gradedRow = Object.assign(row(), { report_variant: 'graded' });
  db = stubDb(gradedRow, fullDoctor);
  const g = await service.getGradedDoc(db, 'r1');
  ok(!g.doc.edition && g.doc.cover.title === 'BodyBank Health Map Report' && g.doc.sections.every((s) => s.type !== 'signoff' && s.type !== 'insights'),
    'a graded-variant row still yields the unchanged Health Map document');
  ok((await service.deliveryStatus(db, 'r1')).signed === true, 'the Health Map needs no sign-off');
  db = stubDb(Object.assign(row(), { report_variant: 'classic' }), fullDoctor);
  ok((await service.deliveryStatus(db, 'r1')).signed === true, 'the standard report needs no sign-off');

  db = stubDb(Object.assign(row(), { report_variant: 'classic' }), fullDoctor);
  const sw = await service.setVariant(db, 'r1', 'complete');
  ok(sw.variant === 'complete' && db.row.report_variant === 'complete' && db.row.graded_report, 'switching to 360 builds the engine output it needs');
  db = stubDb(Object.assign(row(), { extracted_blood_data: null }), fullDoctor);
  ok(!!(await service.setVariant(db, 'r1', 'complete')).error, 'cannot switch an unprocessed report to 360');
}

serviceTests().then(() => {
  console.log('-'.repeat(62));
  if (failures.length) {
    console.log(`FAILED  ${failures.length} of ${passed + failures.length} checks — Health Map 360\n`);
    failures.forEach((f) => console.log('  * ' + f));
    process.exitCode = 1;
  } else {
    console.log(`PASSED  ${passed} checks — Health Map 360 engines, document and sign-off`);
  }
}).catch((e) => { console.error(e); process.exitCode = 1; });
