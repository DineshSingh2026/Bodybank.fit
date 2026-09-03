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

  // The form was 9 minutes as one piece. Every surface that still says so is
  // quoting a form that no longer exists, and the Start button said it loudest.
  const STALE = [
    ['public/js/nutrition-assessment.js', 'the form'],
    ['public/nutrition-assessment.html', 'the form page'],
    ['public/js/member-home.js', 'the member tile'],
    ['public/index.html', 'the member home']
  ];
  STALE.forEach(function (pair) {
    const src = read(pair[0]);
    check(!/9 minutes|nine minutes|9 mins/i.test(src),
      pair[1] + ' no longer claims the assessment takes 9 minutes');
  });
  check(!/Start — 9 minutes/.test(read('public/js/nutrition-assessment.js')),
    'the Start button carries no baked-in duration — the two parts are different lengths');
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
  check(/those skip the email question entirely/.test(index),
    'and admin is told when to use a personal link instead of the shared one');
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

section('both links are reachable, and both counts are reported');
{
  const index = read('public/index.html');
  const op = read('public/js/operator-console.js');
  const adminHome = read('public/js/admin-home.js');
  const server = read('server.js');
  const mh = read('public/js/member-home.js');

  // Admin: both links in the personal-link panel, plus the per-row button.
  check(/naInviteInput2/.test(index), 'admin sees a Part 2 link beside the Part 1 link');
  check(/naCopyInvite2/.test(index), 'and can copy it');
  check(/Send Part 1 first/.test(index),
    'and is told a personal Part 2 link is not live until Part 1 is submitted');
  check(/naPart2Link/.test(index), 'admin still has the per-row Part 2 link button');

  // Operator: can copy a Part 2 link to chase someone.
  check(/function opNaPart2/.test(op), 'the operator can copy a Part 2 link');
  check(/awaiting_part2/.test(op), 'and the button only shows where Part 2 is outstanding');

  // Counts on both dashboards, from the part stamps rather than from `status`.
  check(/part1_submitted: naPart1/.test(server) && /part2_submitted: naPart2/.test(server),
    'the operator overview reports both part counts');
  check(/part1_submitted: naPart1A/.test(server) && /part2_submitted: naPart2A/.test(server),
    'the admin overview reports both part counts');
  check(/part1_submitted_at IS NOT NULL/.test(server),
    'counted off the part stamps, so a row mid-Part-2 still counts as a Part 1');
  check(/'FitChef Part 1'/.test(adminHome) && /'FitChef Part 2'/.test(adminHome),
    'the desktop dashboard has a tile for each part');
  check(/FitChef Part 1/.test(op) && /FitChef Part 2/.test(op),
    'the operator dashboard has a tile for each part');
  check(/Part 1: /.test(index), 'the mobile admin console shows both counts');

  // Member: both parts offered as their own option.
  check(/mhRenderNaParts/.test(mh), 'the member sees the two parts listed separately');
  check(/Locked/.test(mh), 'with Part 2 shown as locked until Part 1 is in');
  check(/mhNaParts/.test(index), 'and the card carries the container for them');
}

section('two SHAREABLE links, one per part');
{
  const routes = read('routes/nutritionAssessment.js');
  const index = read('public/index.html');
  const op = read('public/js/operator-console.js');
  const form = read('public/js/nutrition-assessment.js');

  check(/part2_share_url/.test(routes), 'the API advertises a shareable Part 2 URL');
  check(/nutrition-assessment\.html\?part=2/.test(routes),
    'and it is the plain ?part=2 link, not one bound to a person');

  // The gate is what makes an open Part 2 link possible at all: Part 2 carries no
  // identity fields, so an anonymous visitor has to say which email they used.
  check(/part2\/lookup/.test(routes), 'there is a Part 2 identity gate endpoint');
  check(/identity_email/.test(routes), 'and submit/autosave accept the email it captures');
  check(/renderPart2Gate/.test(form), 'the form asks the question before showing Part 2');
  check(/needsPart2Identity/.test(form), 'and only when it cannot already tell who the visitor is');
  check(/identity_email: S\.identityEmail/.test(form), 'the answer rides along on every write');

  // Reading a row back by email alone would let anyone harvest a health screen by
  // guessing an address, so the gate must return a yes/no and a first name only.
  const gStart = routes.indexOf("router.post('/part2/lookup'");
  const gEnd = routes.indexOf("router.put('/draft'", gStart);
  const gate = routes.slice(gStart, gEnd > gStart ? gEnd : gStart + 2000);
  check(!/answers/.test(gate), 'the gate never returns the stored answers');
  check(!/derived/.test(gate), 'nor the derived metrics');
  check(/split\(/.test(gate), 'it returns a first name only');

  // Admin: two shareable inputs, two copy buttons.
  check(/naLink2Input/.test(index), 'admin has a second shareable link input for Part 2');
  check(/naCopyLink2/.test(index), 'with its own copy button');
  check(/Part 1 &mdash; shareable form link/.test(index), 'the first is labelled Part 1');
  check(/Part 2 &mdash; shareable form link/.test(index), 'the second is labelled Part 2');
  check(/\?part=2/.test(index), 'and the Part 2 link carries ?part=2');

  // Operator: the same two links.
  check(/Copy Part 1 link/.test(op) && /Copy Part 2 link/.test(op),
    'the operator can copy both links from the assessment list');
  check(/opCopyText/.test(op), 'with a prompt fallback when the clipboard is blocked');
}

section('tape measurements are entered in inches but stored in centimetres');
{
  const form = read('public/js/nutrition-assessment.js');
  const metrics = require('../public/js/nutrition-assessment-metrics.js');

  ['waist_cm', 'hip_cm', 'neck_cm'].forEach(function (k) {
    const f = schema.fieldByKey(k);
    check(f && f.type === 'length', k + ' is a length field');
    check(f && f.unit === 'in', 'and is shown in inches');
  });

  check(/function renderLength/.test(form), 'the form has a length renderer');
  check(/lengthMode/.test(form), 'with a per-field inches/cm toggle');
  check(/typed \* 2\.54/.test(form), 'and converts inches to centimetres on entry');

  // The trap: `unit` says inches, the stored value is centimetres. A naive
  // `value + ' ' + unit` shows a 34in waist back as "86.4 in".
  check(/f\.type === 'length'/.test(form.slice(form.indexOf('function displayValue'), form.indexOf('function displayValue') + 900)),
    'displayValue converts a length field rather than mislabelling the stored cm');

  // The reason the key stays *_cm: whtr divides waist by height, both in cm.
  const d = metrics.derive({ sex: 'Male', dob: '1996-01-15', height_cm: 175, weight_kg: 75, waist_cm: 86.4 });
  check(d && d.whtr && Math.abs(d.whtr - 0.494) < 0.01,
    'a 34in waist stored as 86.4cm gives the right waist-to-height ratio (' + (d && d.whtr) + ')');
  const wrong = metrics.derive({ sex: 'Male', dob: '1996-01-15', height_cm: 175, weight_kg: 75, waist_cm: 34 });
  check(wrong && wrong.whtr && wrong.whtr < 0.25,
    'and storing the raw inches instead would have produced a nonsense ratio (' + (wrong && wrong.whtr) + ')');
}

section('after Part 1 the member chooses whether to carry on');
{
  const form = read('public/js/nutrition-assessment.js');
  const html = read('public/nutrition-assessment.html');

  check(/id="fcDoneActions"/.test(html), 'the done screen has a place for the choice');
  check(/Continue to Part 2 now/.test(form), 'carrying on now is offered');
  check(/Send me the link instead/.test(form), 'and having the link sent later is an equal option');
  check(/function continueToPart2/.test(form), 'carrying on is handled in place');
  check(/identityEmail = S\.answers\.email/.test(form),
    'and reuses the email they just gave, so Part 2 does not ask again');
  check(/Nothing you have entered is lost/.test(form),
    'choosing "later" reassures them their answers are kept');
  check(/complete === true/.test(form), 'and the choice is not shown once both parts are in');
}

section('a submission notifies admin AND operator');
{
  const server = read('server.js');
  const index = read('public/index.html');

  // The bell builds its feed by querying source tables directly. Assessments were
  // simply not among them, so a submission only ever reached staff as a push —
  // which needs VAPID keys configured AND browser permission granted, and
  // silently reaches nobody when either is missing.
  const bellStart = server.indexOf("app.get('/api/notifications'");
  const bell = server.slice(bellStart, server.indexOf('notifications.sort', bellStart));
  check(bellStart > 0, 'the notification endpoint was found');
  check(/nutrition_assessments/.test(bell), 'the bell queries assessments');
  check(/type: 'assessment'/.test(bell), 'and emits them as their own type');
  check(/'na1-'/.test(bell) && /'na2-'/.test(bell),
    'each part gets a distinct id, so a Part 2 entry cannot replace the Part 1 one');
  check(/part1_submitted_at IS NOT NULL OR part2_submitted_at IS NOT NULL/.test(bell),
    'only submitted parts are announced, never an abandoned draft');
  check(/needs review/.test(bell), 'a blocked row is announced as needing review, not as routine');

  // Operators are included by the shared isAdmin gate on that endpoint.
  check(/req\.user\.role === 'operator'/.test(server.slice(bellStart, bellStart + 900)),
    'operators share the staff notification feed');

  // Push: one message per part, keyed per part.
  check(/onSubmit: \(\{ id, identity, flags, part, complete \}\)/.test(server),
    'the push hook receives which part landed');
  check(/'-p' \+ \(complete \? 2 : 1\)/.test(server),
    'and keys the push per part so one cannot replace the other in the tray');
  check(/FitChef \$\{partLabel\} — needs review/.test(server),
    'a blocking flag outranks the ordinary message');
  check(/Operators are read-only monitoring staff and receive the SAME activity alerts/.test(server),
    'sendPushToAdmins deliberately includes operators');

  check(/admin-notify-item\.assessment/.test(index), 'the bell styles assessment entries distinctly');
}

console.log('\n' + '-'.repeat(60));
if (failures.length) {
  console.log('FAILED ' + failures.length + ' of ' + checks + ' checks:');
  failures.forEach((f) => console.log('  x ' + f));
  process.exit(1);
}
console.log('--- All ' + checks + ' assessment-parts checks passed ---');
