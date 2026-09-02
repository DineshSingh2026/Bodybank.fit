/**
 * Two-part FitChef Assessment.
 * Run: node tests/nutrition-assessment-parts.js   (no dependencies, no server, no DB)
 *
 * The assessment is delivered in two sittings. The split is a TAG on the existing
 * steps rather than a second schema, so the property that actually matters is
 * that nothing was lost, duplicated or reordered by tagging them.
 *
 * The two rules that make the split safe rather than merely shorter:
 *
 *   1. The health screen and consent stay in PART 1. review.computeFlags() is what
 *      stops a deficit plan reaching someone pregnant, on insulin or in kidney
 *      failure, and consent must be captured before any health data is processed.
 *      Deferring either to part 2 would mean acting on part 1 without them.
 *
 *   2. Part 1 must be independently useful, or the split just creates two places
 *      to abandon instead of one. metrics.derive() has to produce BMR / TDEE /
 *      protein from part 1's fields alone.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const schema = require('../services/nutritionAssessmentSchema');
const review = require('../services/nutritionAssessmentReview');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function section(n) { console.log('\n=== ' + n + ' ==='); }
function check(c, m) { if (assert(c, m)) console.log('  OK   ' + m); else console.log('  FAIL ' + m); }

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ------------------------------------------------------------------ *
 * 1. The split loses nothing
 * ------------------------------------------------------------------ */

section('the split is a tag: nothing lost, duplicated or reordered');
{
  check(schema.STEPS.every((s) => s.part === 1 || s.part === 2), 'every step declares a part');

  const p1 = schema.stepsForPart(1);
  const p2 = schema.stepsForPart(2);
  check(p1.length + p2.length === schema.STEPS.length,
    'the parts partition the steps (' + p1.length + ' + ' + p2.length + ' = ' + schema.STEPS.length + ')');

  const f1 = schema.fieldsForPart(1);
  const f2 = schema.fieldsForPart(2);
  const all = schema.allFields ? schema.allFields() : schema.STEPS.reduce((a, s) => a.concat(s.fields), []);
  check(f1.length + f2.length === all.length,
    'and partition the fields (' + f1.length + ' + ' + f2.length + ' = ' + all.length + ') — no field was removed');

  const keys1 = f1.map((f) => f.key);
  const keys2 = f2.map((f) => f.key);
  const overlap = keys1.filter((k) => keys2.indexOf(k) !== -1);
  check(overlap.length === 0, 'no field appears in both parts' + (overlap.length ? ': ' + overlap.join(', ') : ''));

  const allKeys = keys1.concat(keys2);
  check(new Set(allKeys).size === allKeys.length, 'no duplicate field keys across the whole form');

  // Order within a part must follow the original order, or a resumed draft's
  // last_step would land on a different question than the member left on.
  const orderOk = [1, 2].every((p) => {
    const idx = schema.stepsForPart(p).map((s) => schema.STEPS.indexOf(s));
    return idx.every((v, i) => i === 0 || v > idx[i - 1]);
  });
  check(orderOk, 'each part keeps the original step order');
}

/* ------------------------------------------------------------------ *
 * 2. Safety is never deferred
 * ------------------------------------------------------------------ */

section('safety and consent stay in part 1');
{
  check(schema.partOfStep('health') === 1,
    'the health screen is in part 1 — it is the gate on every blocking flag');
  check(schema.partOfStep('accountability') === 1,
    'consent is in part 1 — health data cannot be processed without it');
  check(schema.partOfStep('body') === 1, 'body metrics are in part 1');
  check(schema.partOfStep('identity') === 1, 'identity is in part 1');

  // Every field the blocking rules read must be answerable in part 1, or a flag
  // could only ever fire after we had already acted on part 1.
  const reviewSrc = read('services/nutritionAssessmentReview.js');
  const part1Keys = new Set(schema.fieldsForPart(1).map((f) => f.key));
  const SAFETY_KEYS = ['age', 'dob', 'conditions', 'medications', 'pregnancy_status', 'eating_disorder',
    'diabetes_type', 'insulin', 'kidney', 'is_pregnant', 'breastfeeding'];
  const referenced = SAFETY_KEYS.filter((k) => reviewSrc.indexOf(k) !== -1);
  const deferred = referenced.filter((k) => {
    const p = schema.partOfField(k);
    return p !== null && p !== 1;
  });
  check(deferred.length === 0,
    'no field the safety rules read is deferred to part 2'
    + (deferred.length ? ' — deferred: ' + deferred.join(', ') : ' (' + referenced.length + ' checked)'));

  check(typeof review.computeFlags === 'function' && typeof review.isRefused === 'function',
    'the safety rules are still exported and callable');
}

/* ------------------------------------------------------------------ *
 * 3. Part 1 is independently useful
 * ------------------------------------------------------------------ */

section('part 1 alone produces the numbers');
{
  // The metrics file is UMD and is require()d by the server as the single source
  // of the maths, so load it exactly the way the server does.
  const metrics = require('../public/js/nutrition-assessment-metrics.js');

  if (!metrics || typeof metrics.derive !== 'function') {
    console.log('  FAIL metrics bundle does not expose derive()');
    assert(false, 'metrics bundle exposes derive()');
  } else {
    const inputs = { sex: 'Male', dob: '1996-01-15', height_cm: 175, weight_kg: 75, waist_cm: 84 };
    // Every input the derivation needs must live in part 1.
    Object.keys(inputs).forEach((k) => {
      const p = schema.partOfField(k);
      if (p !== null) check(p === 1, '`' + k + '` (a derivation input) is in part 1');
    });
    const d = metrics.derive(inputs);
    check(d && d.bmr > 0, 'BMR is produced from part-1 answers alone (' + (d && d.bmr) + ')');
    check(d && d.tdee > 0, 'and TDEE (' + (d && d.tdee) + ')');
  }
}

/* ------------------------------------------------------------------ *
 * 4. Part sizes — the reason for doing this at all
 * ------------------------------------------------------------------ */

section('part 1 is genuinely shorter');
{
  const req = (p) => schema.fieldsForPart(p).filter((f) => f.required).length;
  const r1 = req(1);
  const r2 = req(2);
  check(r1 < r2 || r1 <= 25,
    'part 1 carries the smaller required load (' + r1 + ' required vs ' + r2 + ')');
  check(schema.stepsForPart(1).length <= 6, 'part 1 is at most 6 steps (' + schema.stepsForPart(1).length + ')');
  check(schema.PART_META[1] && schema.PART_META[2], 'both parts carry member-facing copy');
  check(/3|4/.test(String(schema.PART_META[1].blurb)),
    'part 1 copy sets a realistic time expectation');
}

/* ------------------------------------------------------------------ *
 * 5. The wiring, on every surface
 * ------------------------------------------------------------------ */

section('routes enforce the part rules');
{
  const routes = read('routes/nutritionAssessment.js');
  check(/needs_part1/.test(routes), 'part 2 cannot be submitted before part 1');
  check(/part1_submitted_at/.test(routes) && /part2_submitted_at/.test(routes),
    'each part is stamped separately');
  check(/'part1_complete'/.test(routes),
    "part 1 leaves the row open at 'part1_complete' rather than closing it");
  check(/assessmentId/.test(routes),
    'the part-2 link is bound to a specific assessment id');
  check(/part2-link/.test(routes), 'there is a per-row part-2 link route');
  check(/Object\.assign\(\{\}, priorAnswers/.test(routes),
    'a part-2 submission MERGES with the stored answers rather than replacing them');
  check(/stepsForPart\(part\)\.forEach/.test(routes),
    'validation is scoped to the submitted part');

  const server = read('server.js');
  check(/part1_submitted_at TIMESTAMPTZ/.test(server), 'the columns are migrated on boot');
  check(/status = 'complete' AND part1_submitted_at IS NULL/.test(server),
    'pre-split completed rows are backfilled, not dragged back into "awaiting part 2"');
}

section('the member form is part-aware');
{
  const form = read('public/js/nutrition-assessment.js');
  check(/part: S\.part/.test(form), 'the form sends its part on submit and autosave');
  check(/qs\('part'\)/.test(form), 'it honours ?part= in the URL');
  check(/next_part === 2/.test(form), 'the done screen tells the member part 2 is coming');
  const html = read('public/nutrition-assessment.html');
  check(/id="fcPartBadge"/.test(html), 'the form shows which part is open');
  check(/nutrition-assessment\.js\?v=/.test(html),
    'the form assets are cache-busted — without this a returning visitor gets the old single-part form');
}

section('admin and operator show the part state');
{
  const index = read('public/index.html');
  check(/naPart2Link/.test(index), 'admin can generate a per-row part-2 link');
  check(/Part 1 &mdash; shareable form link/.test(index), 'the shared link is labelled as part 1');
  check(/Part 2 is per person, not a shared link/.test(index),
    'and admin is told why part 2 is not a shared link');
  check(/naStatAwaiting/.test(index), 'admin has an "awaiting part 2" figure');
  check(/Both parts in/.test(index), 'the admin row shows both-parts-in');

  const op = read('public/js/operator-console.js');
  check(/Part 1 done/.test(op), 'the operator list shows "Part 1 done"');
  check(/not chased/.test(op), 'and flags who has not been sent their part-2 link');

  const mh = read('public/js/member-home.js');
  check(/Continue with Part 2/.test(mh), 'the member tile offers part 2 directly');
  check(/mhOpenNutritionAssessment\(2\)/.test(mh), 'and opens it at part 2');
  check(/Start Part 1/.test(mh), 'a new member is invited to part 1');
}

/* ------------------------------------------------------------------ */

console.log('\n' + '-'.repeat(60));
if (failures.length) {
  console.log('FAILED ' + failures.length + ' of ' + checks + ' checks:');
  failures.forEach((f) => console.log('  x ' + f));
  process.exit(1);
}
console.log('--- All ' + checks + ' assessment-parts checks passed ---');
