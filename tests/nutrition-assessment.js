'use strict';

/**
 * FitChef Nutrition Assessment — unit tests.
 *
 * No database and no HTTP: these cover the three pieces where a mistake is
 * silent and expensive — the conditional-visibility grammar (a wrong `when`
 * hides a required question and the form can never be submitted), the metabolic
 * maths shared with the browser, and the §11 red-flag rules that decide whether
 * a submission may be auto-planned at all.
 *
 * Run: node tests/nutrition-assessment.js
 */

const assert = require('assert');
const schema = require('../services/nutritionAssessmentSchema');
const metrics = require('../public/js/nutrition-assessment-metrics');
const review = require('../services/nutritionAssessmentReview');
const prefill = require('../services/nutritionAssessmentPrefill');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\nnutrition-assessment — schema');

test('ten steps, every field has a key, label and type', () => {
  assert.strictEqual(schema.STEPS.length, 10);
  const keys = new Set();
  schema.allFields().forEach((f) => {
    assert.ok(f.key, 'missing key in step ' + f.step);
    assert.ok(f.label, 'missing label for ' + f.key);
    assert.ok(f.type, 'missing type for ' + f.key);
    assert.ok(!keys.has(f.key), 'duplicate field key: ' + f.key);
    keys.add(f.key);
  });
});

test('every select/multi field offers options', () => {
  schema.allFields().forEach((f) => {
    if (f.type === 'select' || f.type === 'multi') {
      assert.ok(Array.isArray(f.options) && f.options.length, f.key + ' has no options');
    }
  });
});

test('every `when` clause points at a field that exists', () => {
  const keys = new Set(schema.allFields().map((f) => f.key).concat(['_is_member']));
  const walk = (c) => {
    if (!c) return;
    if (Array.isArray(c.any)) return c.any.forEach(walk);
    if (Array.isArray(c.all)) return c.all.forEach(walk);
    assert.ok(keys.has(c.field), 'when-clause references unknown field: ' + c.field);
  };
  schema.allFields().forEach((f) => walk(f.when));
});

test('matches(): in / not / has / truthy', () => {
  const a = { diet_type: 'Non-vegetarian', conditions: ['PCOS / PCOD', 'IBS'], body_fat_pct: 18 };
  assert.strictEqual(schema.matches({ field: 'diet_type', in: ['Non-vegetarian'] }, a), true);
  assert.strictEqual(schema.matches({ field: 'diet_type', in: ['Vegan'] }, a), false);
  assert.strictEqual(schema.matches({ field: 'conditions', has: ['IBS'] }, a), true);
  assert.strictEqual(schema.matches({ field: 'conditions', has: ['Anaemia'] }, a), false);
  assert.strictEqual(schema.matches({ field: 'body_fat_pct', truthy: true }, a), true);
  assert.strictEqual(schema.matches({ field: 'body_fat_pct', truthy: true }, {}), false);
  // `not` on an unanswered field must be false, or a conditional would render
  // before its trigger has been touched.
  assert.strictEqual(schema.matches({ field: 'trains', not: ['Not currently'] }, {}), false);
  assert.strictEqual(schema.matches({ field: 'trains', not: ['Not currently'] }, { trains: '3–4× week' }), true);
});

test('a vegetarian is never asked how many non-veg days', () => {
  const f = schema.fieldByKey('nonveg_days');
  assert.strictEqual(schema.matches(f.when, { diet_type: 'Vegetarian' }), false);
  assert.strictEqual(schema.matches(f.when, { diet_type: 'Non-vegetarian' }), true);
});

test('someone who does not train is never asked for a training split', () => {
  ['training_types', 'session_minutes', 'training_time', 'trains_fasted'].forEach((k) => {
    assert.strictEqual(schema.matches(schema.fieldByKey(k).when, { trains: 'Not currently' }), false, k);
    assert.strictEqual(schema.matches(schema.fieldByKey(k).when, { trains: '3–4× week' }), true, k);
  });
});

test('a typical member sees well under the full field count', () => {
  const typical = {
    _is_member: 'yes', diet_type: 'Vegetarian', trains: '3–4× week', conditions: ['None of these'],
    sex: 'Male', has_bloodwork: 'No', alcohol_frequency: 'Never', past_attempts: 'Never',
    goal_primary: 'Fat loss', occupation_type: 'Desk', tea_coffee_cups: '1–2', does_if: 'No',
    allergies: ['None'], bloating: 'Never', cravings: ['No strong cravings'], household_size: '1',
    cooking_time: '15–30 min', delivery_interest: 'Just the plan, no delivery', has_coach: 'No'
  };
  const shown = schema.allFields().filter((f) => !f.when || schema.matches(f.when, typical));
  assert.ok(shown.length < schema.allFields().length * 0.75,
    'expected conditionals to hide at least a quarter of the form, saw ' + shown.length + '/' + schema.allFields().length);
});

console.log('\nnutrition-assessment — metrics');

test('Mifflin–St Jeor matches the published worked example', () => {
  // 80kg, 178cm, 30y male → 10(80) + 6.25(178) − 5(30) + 5 = 1767.5, rounded
  assert.strictEqual(metrics.bmr('Male', 80, 178, 30), 1768);
  // same body, female → −161 instead of +5
  assert.strictEqual(metrics.bmr('Female', 80, 178, 30), 1602);
});

test('BMR is null until every input is there', () => {
  assert.strictEqual(metrics.bmr('Male', 80, 178, null), null);
  assert.strictEqual(metrics.bmr('Male', null, 178, 30), null);
});

test('activity factor rises with steps, training and work, and is capped', () => {
  const sed = metrics.activityFactor({ daily_steps: '<3k', trains: 'Not currently', occupation_type: 'Desk' });
  const busy = metrics.activityFactor({ daily_steps: '12k+', trains: 'Daily', occupation_type: 'Physical labour' });
  assert.strictEqual(sed, 1.2);
  assert.ok(busy > sed);
  assert.ok(busy <= 1.9, 'factor must stay inside a defensible range, saw ' + busy);
});

test('waist-to-height ratio and its band', () => {
  assert.strictEqual(metrics.whtr(89, 178), 0.5);
  assert.strictEqual(metrics.whtrBand(0.45).key, 'ok');
  assert.strictEqual(metrics.whtrBand(0.55).key, 'raised');
  assert.strictEqual(metrics.whtrBand(0.65).key, 'high');
});

test('protein target lifts for training and a fat-loss goal', () => {
  const rest = metrics.proteinTarget({ weight_kg: 80, trains: 'Not currently' });
  const cut = metrics.proteinTarget({ weight_kg: 80, trains: '3–4× week', goal_primary: 'Fat loss' });
  assert.ok(cut.low > rest.low);
});

test('declared kidney disease pins protein to the conservative ceiling', () => {
  const renal = metrics.proteinTarget({ weight_kg: 80, trains: 'Daily', goal_primary: 'Muscle gain', renal: true });
  assert.deepStrictEqual(renal, { low: 48, high: 64 });
});

test('derive() produces the full teaser from the four Step-3 answers', () => {
  const d = metrics.derive({
    dob: '1994-06-01', sex: 'Male', weight_kg: 82, height_cm: 178, waist_cm: 92,
    daily_steps: '5–8k', trains: '3–4× week', occupation_type: 'Desk', goal_primary: 'Fat loss',
    goal_pace: 'Steady (0.25–0.5 kg/wk)'
  });
  assert.ok(d.bmr > 1500 && d.bmr < 2200);
  assert.ok(d.tdee > d.bmr);
  assert.ok(d.calorie_target < d.tdee, 'a fat-loss goal must produce a deficit');
  assert.strictEqual(d.whtr, 0.52);
  assert.ok(d.protein_target_g.low > 100);
});

console.log('\nnutrition-assessment — red-flag routing');

test('under 18 is refused outright, not merely flagged', () => {
  const f = review.computeFlags({ dob: new Date(Date.now() - 15 * 365.25 * 86400000).toISOString().slice(0, 10) });
  assert.ok(f.some((x) => x.code === 'age_under_18'));
  assert.strictEqual(review.isRefused(f), true);
});

test('kidney disease and type 1 diabetes both demand a clinician', () => {
  const f = review.computeFlags({ dob: '1990-01-01', conditions: ['Kidney disease or stones', 'Type 1 diabetes'] });
  const codes = f.map((x) => x.code);
  assert.ok(codes.includes('kidney') && codes.includes('t1_diabetes'));
  assert.ok(f.filter((x) => ['kidney', 't1_diabetes'].includes(x.code)).every((x) => x.clinician && x.block));
  assert.strictEqual(review.reviewStatus(f), 'blocked');
});

test('T2 blocks only once insulin is involved', () => {
  const plain = review.computeFlags({ dob: '1990-01-01', conditions: ['Type 2 diabetes'], on_insulin: 'No' });
  const insulin = review.computeFlags({ dob: '1990-01-01', conditions: ['Type 2 diabetes'], on_insulin: 'Yes' });
  assert.ok(!plain.some((x) => x.code === 't2_insulin'));
  assert.ok(insulin.some((x) => x.code === 't2_insulin'));
});

test('pregnancy and breastfeeding block any deficit plan', () => {
  ['Pregnant', 'Breastfeeding'].forEach((s) => {
    const f = review.computeFlags({ dob: '1992-01-01', sex: 'Female', pregnancy_status: s });
    assert.ok(f.some((x) => x.code === 'pregnancy' && x.block), s);
  });
  assert.ok(!review.computeFlags({ dob: '1992-01-01', pregnancy_status: 'No' }).some((x) => x.code === 'pregnancy'));
});

test('disordered-eating signals block, from the dropdown or the free text', () => {
  assert.ok(review.computeFlags({ dob: '1990-01-01', emotional_eating: 'Very often' })
    .some((x) => x.code === 'emotional_eating' && x.block));
  assert.ok(review.computeFlags({ dob: '1990-01-01', emotional_eating: 'Sometimes', food_relationship_notes: 'I binge at night and then skip the next day' })
    .some((x) => x.code === 'food_distress' && x.block));
});

test('an underweight fat-loss request goes to a human', () => {
  const f = review.computeFlags({ dob: '1995-01-01', weight_kg: 45, height_cm: 170, goal_primary: 'Fat loss' });
  assert.ok(f.some((x) => x.code === 'underweight_fatloss'));
});

test('an unsafe pace is downgraded, not blocked', () => {
  const soon = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
  const f = review.computeFlags({ dob: '1990-01-01', weight_kg: 90, target_weight: 78, target_date: soon });
  const pace = f.filter((x) => x.code === 'pace_too_fast')[0];
  assert.ok(pace, 'expected a pace flag');
  assert.strictEqual(pace.block, false);
});

test('a clean submission raises nothing and stays unblocked', () => {
  const f = review.computeFlags({
    dob: '1990-01-01', sex: 'Male', conditions: ['None of these'], weight_kg: 80, height_cm: 178,
    goal_primary: 'Fat loss', emotional_eating: 'Sometimes', goal_pace: 'Steady (0.25–0.5 kg/wk)'
  });
  assert.deepStrictEqual(f, []);
  assert.strictEqual(review.reviewStatus(f), '');
});

console.log('\nnutrition-assessment — prefill mapping');

test('numbers become the bands the form actually asks for', () => {
  assert.strictEqual(prefill.stepsBand(2400), '<3k');
  assert.strictEqual(prefill.stepsBand(6500), '5–8k');
  assert.strictEqual(prefill.stepsBand(14000), '12k+');
  assert.strictEqual(prefill.waterBand(2500), '2–3');
  assert.strictEqual(prefill.sleepBand(7.4), '7–8');
  assert.strictEqual(prefill.trainsBand(4), '3–4× week');
  assert.strictEqual(prefill.trainsBand(0), 'Not currently');
  assert.strictEqual(prefill.stepsBand(NaN), null);
});

test('every band a prefill can produce is a real option on its field', () => {
  const opts = (k) => schema.fieldByKey(k).options;
  [prefill.stepsBand(2000), prefill.stepsBand(6000), prefill.stepsBand(20000)].forEach((v) =>
    assert.ok(opts('daily_steps').includes(v), 'daily_steps: ' + v));
  [500, 1500, 2500, 3500, 5000].forEach((ml) =>
    assert.ok(opts('water_litres').includes(prefill.waterBand(ml)), 'water: ' + ml));
  [4, 5.5, 6.5, 7.5, 9].forEach((h) =>
    assert.ok(opts('sleep_hours').includes(prefill.sleepBand(h)), 'sleep: ' + h));
  [0, 2, 4, 6, 7].forEach((d) =>
    assert.ok(opts('trains').includes(prefill.trainsBand(d)), 'trains: ' + d));
});

test('lab markers are pulled out of an extracted blood report', () => {
  const labs = prefill.labsFromExtract({
    panels: [
      { name: 'Diabetes', markers: [{ name: 'HbA1c (Glycated Haemoglobin)', value: '5.8 %' }, { name: 'Fasting Blood Sugar', value: '96' }] },
      { name: 'Thyroid', markers: [{ name: 'TSH - Ultrasensitive', value: '3.42 mIU/L' }] },
      { name: 'Vitamins', markers: [{ name: 'Vitamin D (25-OH)', value: '18.4' }, { name: 'Vitamin B-12', value: '211' }] },
      { name: 'Junk', markers: [{ name: 'Colour', value: 'Pale yellow' }] }
    ]
  });
  assert.strictEqual(labs.hba1c, 5.8);
  assert.strictEqual(labs.fasting_glucose, 96);
  assert.strictEqual(labs.tsh, 3.42);
  assert.strictEqual(labs.vitamin_d, 18.4);
  assert.strictEqual(labs.b12, 211);
  assert.ok(!('colour' in labs));
});

test('a malformed or empty blood extract yields nothing rather than throwing', () => {
  assert.deepStrictEqual(prefill.labsFromExtract(null), {});
  assert.deepStrictEqual(prefill.labsFromExtract({}), {});
  assert.deepStrictEqual(prefill.labsFromExtract({ panels: 'nope' }), {});
});

console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES' : '') + '\n');
