'use strict';

/**
 * Seeded inputs for the Signature reports — the classic seeded bundle
 * (tests/fixtures/reports/seed.js) plus the extras only Signature reads:
 * mood / stress, wearable HRV / RHR / recovery, all-time lifts, member-since,
 * coach touchpoints, the full Sunday answers and last report's targets.
 *
 *   seedSignature('weekly' | 'monthly', 'normal' | 'empty' | 'extreme')
 *     -> { bundle, extras, previous }
 *
 * Fixed-seed PRNG: identical output on every run. No database, no network.
 */

const S = require('../../../services/reportScore');
const { seedBundle } = require('./seed');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedSignature(type, variant) {
  const v = variant || 'normal';
  const bundle = seedBundle(type, v);
  if (v === 'empty') {
    return { bundle, extras: { moods: [], mindSessions: [], readiness: [], lifts: {}, memberSince: '2026-08-25', touchpoints: { coachMessages: 0, whatsapp: 0, calls: 0, sundayReviews: 0, bloodAnalysed: 0, reports: 0 }, sunday: [], planLabel: '' }, previous: null };
  }
  const rand = mulberry32(v === 'extreme' ? 77 : 4242);
  const end = bundle.current.period.end;
  const start = S.addDays(end, -120);
  const sleepByDay = new Map();
  for (const c of bundle.history.checkins) if (c.source === 'checkin' && c.sleepH != null) sleepByDay.set(c.date, c.sleepH);
  const moods = []; const readiness = []; const mindSessions = [];
  for (const d of S.datesInRange(start, end)) {
    const sl = sleepByDay.get(d);
    const dow = new Date(S.dayNum(d) * 86400000).getUTCDay();
    if (rand() < 0.7) {
      const good = sl != null && sl >= 7;
      moods.push({ date: d, mood: Math.max(1, Math.min(5, Math.round((good ? 4 : 2.8) + (rand() - 0.5) * 1.4))), stress: Math.max(1, Math.min(5, Math.round((dow >= 1 && dow <= 4 ? 3.4 : 2.2) + (rand() - 0.5) * 1.6))) });
    }
    if (rand() < 0.9) {
      const rec = Math.round(Math.max(18, Math.min(96, (sl != null ? sl * 9 : 58) + (rand() - 0.5) * 30)));
      readiness.push({ date: d, hrv: Math.round(52 + rec * 0.25 + (rand() - 0.5) * 8), rhr: Math.round(62 - rec * 0.06 + (rand() - 0.5) * 3), recovery: rec, strain: Math.round((8 + rand() * 9) * 10) / 10 });
    }
    if (rand() < 0.2) mindSessions.push({ date: d, exercise: 'box_breathing' });
  }
  const lifts = {};
  for (const w of bundle.history.workouts) {
    for (const l of w.lifts || []) {
      const cur = lifts[l.key] || { label: l.label, first: { kg: l.kg, date: w.date }, best: { kg: l.kg, date: w.date } };
      if (l.kg > cur.best.kg) cur.best = { kg: l.kg, date: w.date };
      lifts[l.key] = cur;
    }
  }
  const sunday = [{
    date: end,
    achievements: 'Stayed off sugar on weekdays and hit a bench press PR. Felt much stronger on leg day.',
    improve: 'Weekend protein — Saturdays fall apart when we eat out.',
    questions: 'Should I train on Sunday if I miss Friday?',
    differences: 'Clothes fit better, more energy in the afternoon.'
  }];
  const extras = {
    moods, readiness, mindSessions, lifts,
    memberSince: '2026-05-01',
    planLabel: 'Tribe Elite',
    lifetime: { workouts: bundle.history.workouts.length, meals: bundle.history.meals.reduce((t, m) => t + m.meals, 0), checkins: bundle.history.checkins.filter((c) => c.source === 'checkin').length, prs: 38 },
    accessExpiresAt: type === 'monthly' ? '2026-09-12T00:00:00Z' : null,
    touchpoints: { coachMessages: 14, whatsapp: 9, calls: 2, sundayReviews: 4, bloodAnalysed: 1, reports: 4 },
    sunday
  };
  const previous = type === 'monthly'
    ? { periodLabel: 'July 2026', targets: [{ metric: 'workouts', value: 15, label: 'Complete 15 planned workouts' }, { metric: 'protein', value: 20, label: 'Hit 150 g protein on 20 days' }, { metric: 'sleep', value: 18, label: 'Sleep 7 h or more on 18 nights' }] }
    : { periodLabel: '24 – 30 Aug 2026', targets: [{ metric: 'workouts', value: 4, label: 'Complete 4 planned workouts' }, { metric: 'protein', value: 5, label: 'Hit 150 g protein on 5 days' }, { metric: 'sleep', value: 5, label: 'Sleep 7 h or more on 5 nights' }] };
  if (v === 'extreme') {
    extras.planLabel = 'P'.repeat(90);
    extras.sunday = [{ date: end, achievements: ('Enormous ' + 'W'.repeat(60) + ' ').repeat(20), improve: 'I'.repeat(400), questions: 'Q'.repeat(500) }];
    previous.targets = previous.targets.concat([{ metric: 'nope', value: 3, label: 'L'.repeat(300) }]);
  }
  return { bundle, extras, previous };
}

module.exports = { seedSignature };
