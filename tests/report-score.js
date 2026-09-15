'use strict';

/**
 * BodyBank Score — deterministic scoring tests.   node tests/report-score.js
 *
 * Three fixtures (tests/fixtures/reports/score-fixtures.js):
 *   PERFECT  every pillar maxed           -> 100, A+
 *   EMPTY    nothing logged               -> 0, E, health redistributed
 *   PARTIAL  half a week, worked by hand  -> exact pillar scores below
 * plus grade bands, weight redistribution, trend/delta and determinism.
 * No database, no network.
 */

const S = require('../services/reportScore');
const F = require('./fixtures/reports/score-fixtures');

let passed = 0;
const failures = [];
let group = '';
function section(n) { group = n; }
function ok(name, cond, detail) {
  if (cond) { passed += 1; return; }
  failures.push(`[${group}] ${name}` + (detail ? ` :: ${detail}` : ''));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function near(name, actual, expected, tol) {
  ok(name, Math.abs(actual - expected) <= (tol == null ? 0.01 : tol), `expected ~${expected}, got ${actual}`);
}

// ---------------------------------------------------------------------------
section('grade bands');
eq('90 -> A+', S.gradeFor(90), 'A+');
eq('89.5 rounds to 90 -> A+', S.gradeFor(89.5), 'A+');
eq('89 -> A', S.gradeFor(89), 'A');
eq('80 -> A', S.gradeFor(80), 'A');
eq('79 -> B', S.gradeFor(79), 'B');
eq('70 -> B', S.gradeFor(70), 'B');
eq('60 -> C', S.gradeFor(60), 'C');
eq('50 -> D', S.gradeFor(50), 'D');
eq('49 -> E', S.gradeFor(49), 'E');
eq('0 -> E', S.gradeFor(0), 'E');

section('weights');
eq('base weights sum to 100', Object.values(S.BASE_WEIGHTS).reduce((a, b) => a + b, 0), 100);
eq('workout 25', S.BASE_WEIGHTS.workout, 25);
eq('health 10', S.BASE_WEIGHTS.health, 10);

section('trend mapping');
near('+20% -> 1', S.trendScore(120, 100), 1);
near('+35% capped -> 1', S.trendScore(135, 100), 1);
near('flat -> 0.5', S.trendScore(100, 100), 0.5);
near('-10% -> 0.25', S.trendScore(90, 100), 0.25);
near('-20% -> 0', S.trendScore(80, 100), 0);
near('no baseline -> neutral 0.5', S.trendScore(50, 0), 0.5);
near('nothing now -> 0', S.trendScore(0, 100), 0);

section('period helpers');
const pp = S.previousPeriod('2026-09-07', '2026-09-13');
eq('previous week start', pp.start, '2026-08-31');
eq('previous week end', pp.end, '2026-09-06');
const pm = S.previousPeriod('2026-08-01', '2026-08-31');
eq('previous 31-day period start', pm.start, '2026-07-01');
eq('previous 31-day period end', pm.end, '2026-07-31');
eq('days in period', S.daysBetween('2026-09-07', '2026-09-13'), 7);

// ---------------------------------------------------------------------------
section('PERFECT week');
{
  const { cur, prev } = F.perfectWeek();
  const r = S.scoreDataset(cur, prev, null, 'weekly');
  eq('total', r.total, 100);
  eq('grade', r.grade, 'A+');
  for (const k of S.PILLARS) eq(k + ' = 100', r.pillars[k].score, 100);
  eq('new blood data keeps health weighted', r.healthRedistributed, false);
  eq('weights untouched', r.weights.health, 10);
  eq('volume delta +20%', r.pillars.workout.metrics.volumeDeltaPct, 20);
  eq('longest streak 7', r.pillars.consistency.metrics.longestStreak, 7);
  eq('perfect days 7', r.pillars.consistency.metrics.perfectDays, 7);
  eq('both markers improved or in range', r.pillars.health.metrics.bloodGood, 2);
  ok('every pillar graded A+', S.PILLARS.every((k) => r.pillars[k].grade === 'A+'));
}

section('EMPTY week');
{
  const { cur, prev } = F.emptyWeek();
  const r = S.scoreDataset(cur, prev, null, 'weekly');
  eq('total', r.total, 0);
  eq('grade', r.grade, 'E');
  for (const k of ['workout', 'nutrition', 'checkin', 'consistency', 'yoga']) eq(k + ' = 0', r.pillars[k].score, 0);
  eq('health unscorable', r.pillars.health.score, null);
  eq('health redistributed', r.healthRedistributed, true);
  eq('workout weight 30 after redistribution', r.weights.workout, 30);
  eq('nutrition weight 30 after redistribution', r.weights.nutrition, 30);
  eq('health weight 0', r.weights.health, 0);
  eq('no previous data -> no delta', r.pillars.workout.deltaPct, null);
  eq('no previous data -> flat', r.pillars.workout.trend, 'flat');
  eq('no previous total', r.previous, null);
  ok('no pillar has data', S.PILLARS.every((k) => !r.pillars[k].metrics.hasData));
}

section('PARTIAL week (hand-worked)');
{
  const { cur, prev } = F.partialWeek();
  const r = S.scoreDataset(cur, prev, null, 'weekly');
  // workout = 100*(0.6*2/4 + 0.25*trend(9000 vs 10000 = -10% -> 0.25) + 0.15*(RPE 6 -> 1 - 1/3))
  //         = 100*(0.30 + 0.0625 + 0.10) = 46.25
  eq('workout 46', r.pillars.workout.score, 46);
  eq('workout completion 50%', r.pillars.workout.metrics.completionPct, 50);
  eq('volume delta -10%', r.pillars.workout.metrics.volumeDeltaPct, -10);
  // nutrition = 100*(0.5*9/21 + 0.3*1/7 + 0.2*2/7) = 31.43
  eq('nutrition 31', r.pillars.nutrition.score, 31);
  eq('calorie hit days 1', r.pillars.nutrition.metrics.calorieHitDays, 1);
  eq('protein hit days 2', r.pillars.nutrition.metrics.proteinHitDays, 2);
  // checkin = 100*(0.5*4/7 + 0.2*2/7 + 0.15*2/7 + 0.15*2/7) = 42.86
  eq('checkin 43', r.pillars.checkin.score, 43);
  // consistency = 100*(0.5*5/7 + 0.3*4/7 + 0.2*2/7) = 58.57
  eq('consistency 59', r.pillars.consistency.score, 59);
  eq('active days 5', r.pillars.consistency.metrics.activeDays, 5);
  eq('longest streak 4', r.pillars.consistency.metrics.longestStreak, 4);
  eq('perfect days 2', r.pillars.consistency.metrics.perfectDays, 2);
  // yoga = 100*(0.7*1/3 + 0.3*0.5 neutral mobility) = 38.33
  eq('yoga 38', r.pillars.yoga.score, 38);
  eq('no new weigh-in or blood -> redistributed', r.healthRedistributed, true);
  eq('health not counted', r.pillars.health.counted, false);
  // total = (46.25*30 + 31.43*30 + 42.86*15 + 58.57*15 + 38.33*10) / 100 = 42.35
  eq('total 42', r.total, 42);
  eq('grade E', r.grade, 'E');
  eq('previous total present', r.previous != null, true);
  ok('workout trend is down vs a 3-session week', r.pillars.workout.trend === 'down', r.pillars.workout.trend);
  eq('delta = score - previous score', r.pillars.workout.deltaPct, r.pillars.workout.score - r.pillars.workout.previousScore);
}

section('monthly keeps health when it can be scored');
{
  const { cur, prev } = F.partialWeek();
  const r = S.scoreDataset(cur, prev, null, 'monthly');
  // Markers read twice: hemoglobin back in range, vitamin D 24 -> 28 moved toward
  // its range ("improved") -> 2/2 good. No weigh-in in the period, so body-comp
  // cannot be scored and blood carries the whole pillar: 100.
  eq('health scored', r.pillars.health.score, 100);
  eq('body-comp unscorable without a weigh-in', r.pillars.health.components.bodyComp, null);
  eq('not redistributed', r.healthRedistributed, false);
}

section('streak freeze bridges, does not count');
{
  const { cur } = F.partialWeek();
  const c = JSON.parse(JSON.stringify(cur));
  // d5 was inactive; freeze it -> run d1..d4 + d6 = 5 active across the bridge.
  c.checkins.push({ date: F.DAYS[4], source: 'freeze' });
  const r = S.scoreDataset(c, null, null, 'weekly');
  eq('longest streak bridged to 5', r.pillars.consistency.metrics.longestStreak, 5);
  eq('freeze is not a check-in', r.pillars.checkin.metrics.checkinDays, 4);
  eq('freeze is not an active day', r.pillars.consistency.metrics.activeDays, 5);
}

section('wearable rows fill gaps, never count as a check-in');
{
  const { cur } = F.emptyWeek();
  const c = Object.assign({}, cur, { checkins: F.DAYS.map((d) => ({ date: d, source: 'wearable', sleepH: 8, steps: 12000 })) });
  const r = S.scoreDataset(c, null, null, 'weekly');
  eq('0 check-ins', r.pillars.checkin.metrics.checkinDays, 0);
  eq('sleep days still counted', r.pillars.checkin.metrics.sleepOkDays, 7);
  // 100*(0 + 0.2*1 + 0.15*1 + 0) = 35
  eq('checkin 35', r.pillars.checkin.score, 35);
}

section('determinism');
{
  const a = F.partialWeek(); const b = F.partialWeek();
  const r1 = S.scoreDataset(a.cur, a.prev, null, 'weekly');
  const r2 = S.scoreDataset(b.cur, b.prev, null, 'weekly');
  eq('same input, same output', JSON.stringify(r1), JSON.stringify(r2));
  const r3 = S.scoreDataset(a.cur, a.prev, null, 'weekly');
  eq('scoring does not mutate its input', JSON.stringify(r3), JSON.stringify(r1));
}

section('output contract');
{
  const { cur, prev } = F.perfectWeek();
  const r = S.scoreDataset(cur, prev, null, 'weekly');
  ok('total 0..100', r.total >= 0 && r.total <= 100);
  for (const k of S.PILLARS) {
    const p = r.pillars[k];
    ok(k + ' has score/grade/trend/deltaPct/metrics', 'score' in p && 'grade' in p && ['up', 'down', 'flat'].includes(p.trend) && 'deltaPct' in p && typeof p.metrics === 'object');
  }
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`FAILED  ${failures.length} of ${passed + failures.length} checks`);
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`PASSED  ${passed} checks — BodyBank Score`);
