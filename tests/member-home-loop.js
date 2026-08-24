/**
 * Unit test: the member home "Your day" card.
 * Run: node tests/member-home-loop.js
 *
 * NO NETWORK. NO DATABASE. The card is browser code, so it is loaded as text and
 * evaluated with the two globals it depends on stubbed out.
 *
 * The bug this guards: a member who finished the check-in, the workout and a meal
 * on a non-Sunday left only the weekly review open. That step is `soft` (not due
 * yet), so `next` was null while `all` was false — and the card dereferenced the
 * null. The member saw "Could not reach the server", because loadMemberHome had
 * one catch around both the fetch and the render.
 */

const fs = require('fs');
const path = require('path');

const failures = [];
let checks = 0;

function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}

function contains(html, needle, msg) {
  return assert(html.indexOf(needle) >= 0, `${msg} — "${needle}" not in the card`);
}

// --- load the browser module -------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'member-home.js'), 'utf8');
const head = src.split('/* ---------------------------------------------------------------- render */')[0];
const sandbox = { escapeHtml: (v) => String(v == null ? '' : v), window: {} };
// eslint-disable-next-line no-new-func
const load = new Function('escapeHtml', 'window', head + '\nreturn { mhLoopCard, mhGoAttr };');
const { mhLoopCard } = load(sandbox.escapeHtml, sandbox.window);

// --- the same step list renderMemberHome builds ------------------------------
function buildSteps(t) {
  const steps = [
    { key: 'checkin', done: !!t.checked_in, icon: '✅', title: 'Daily check-in', doneTitle: 'Checked in today', sub: 'Steps, water, protein and sleep', doneSub: 'Logged', cta: 'Check in now', tab: 'checkin', sub2: 'daily' },
    { key: 'workout', done: !!t.workout_logged, icon: '🏋️', title: 'Log your workout', doneTitle: 'Workout logged', sub: 'Record the session', doneSub: 'Nice work', cta: 'Log workout', tab: 'workout' },
    { key: 'meal', done: (t.meals_logged || 0) > 0, icon: '🥗', title: 'Log a meal', doneTitle: 'Meal logged', sub: 'Photograph it', doneSub: 'Keep going', cta: 'Log a meal', tab: 'checkin', sub2: 'nutrition' }
  ];
  if (t.is_sunday || !t.sunday_done) {
    steps.push({ key: 'sunday', done: !!t.sunday_done, icon: '📆', title: 'Weekly check-in', doneTitle: 'Weekly check-in done', sub: 'How did the week go?', doneSub: 'Submitted', cta: 'Open weekly check-in', tab: 'checkin', sub2: 'sunday', soft: !t.is_sunday });
  }
  return steps;
}

function run() {
  // 1. Every reachable day-state renders without throwing.
  for (const is_sunday of [false, true]) {
    for (const sunday_done of [false, true]) {
      for (let mask = 0; mask < 8; mask += 1) {
        const t = {
          checked_in: !!(mask & 1),
          workout_logged: !!(mask & 2),
          meals_logged: (mask & 4) ? 1 : 0,
          sunday_done,
          is_sunday
        };
        const label = `checkin=${t.checked_in} workout=${t.workout_logged} meal=${!!t.meals_logged} sunday_done=${sunday_done} is_sunday=${is_sunday}`;
        let html = '';
        let threw = null;
        try { html = mhLoopCard(buildSteps(t)); } catch (e) { threw = e; }
        assert(!threw, `card threw for ${label} — ${threw && threw.message}`);
        assert(html.indexOf('undefined') < 0, `card printed "undefined" for ${label}`);
        assert(html.indexOf('null') < 0, `card printed "null" for ${label}`);
      }
    }
  }

  // 2. The reported state: everything due is done, only the weekly review is left
  //    on a Tuesday. The day reads complete, and the soft step is listed, not led with.
  const doneDay = mhLoopCard(buildSteps({ checked_in: true, workout_logged: true, meals_logged: 1, sunday_done: false, is_sunday: false }));
  contains(doneDay, 'Today is complete.', 'the day with only a soft step left should read complete');
  contains(doneDay, 'mh-day-card is-done', 'the card should carry the finished state class');
  assert(doneDay.indexOf('Do this next') < 0, 'a not-yet-due step must never be the "Do this next" headline');
  contains(doneDay, 'Weekly check-in', 'the weekly review should still be listed as a row');
  contains(doneDay, '3 of 3 done today', 'the rail should count only what is due today');

  // 3. A genuinely open day still leads with the first due step.
  const openDay = mhLoopCard(buildSteps({ checked_in: true, workout_logged: false, meals_logged: 0, sunday_done: false, is_sunday: false }));
  contains(openDay, 'Do this next', 'an open day should headline the next step');
  contains(openDay, 'Log your workout', 'the next step should be the first thing actually due');
  contains(openDay, '1 of 3 done today', 'the rail should reflect one finished task');
  assert(openDay.indexOf('is-done') < 0, 'an open day must not claim to be finished');

  // 4. On Sunday the weekly review IS due, so it counts and can lead.
  const sunday = mhLoopCard(buildSteps({ checked_in: true, workout_logged: true, meals_logged: 1, sunday_done: false, is_sunday: true }));
  contains(sunday, 'Do this next', 'on Sunday the weekly review is due and should headline');
  contains(sunday, '3 of 4 done today', 'on Sunday the weekly review joins the rail');

  // 5. A fully finished day, weekly review included, gets the plain copy.
  const allDone = mhLoopCard(buildSteps({ checked_in: true, workout_logged: true, meals_logged: 1, sunday_done: true, is_sunday: false }));
  contains(allDone, 'Every box ticked.', 'a fully finished day should get the unqualified copy');

  if (failures.length > 0) {
    console.log('--- FAILURES ---');
    failures.forEach((f) => console.log(' ', f));
    console.log(`\n${failures.length} of ${checks} checks FAILED`);
    process.exit(1);
  }
  console.log(`--- All ${checks} member-home-loop checks passed ---`);
}

try {
  run();
} catch (e) {
  console.error(e);
  process.exit(1);
}
