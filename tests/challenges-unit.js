/**
 * Unit test: BodyBank Challenges (services/challengeService.js + seed files + UI bundles).
 * Run: node tests/challenges-unit.js
 *
 * NO NETWORK. NO DATABASE.
 *
 * What this guards:
 *  - localDayOf across zones (Toronto vs Kolkata) and the DST boundary, naive vs tz-aware;
 *  - every task kind, and the evidence rule: back-dated check-ins / meals / Coach Mode
 *    workouts do NOT count, a check-in edited after its day does not upgrade value tasks,
 *    freeze rows are excluded, My Workout rows under 5 minutes are ignored;
 *  - completion: 6 of 7 with one grace day, 85 % for longer runs, early fail when impossible;
 *  - reward / coin keys are unique per enrollment and day;
 *  - leaderboard: members only, opt-outs and 24 h-old accounts hidden, ties by earlier finish;
 *  - discount math (server side, whole rupees, expiry, tier, single use);
 *  - the rollout flag (off by default);
 *  - seed files valid; migration SQL identical to the boot DDL;
 *  - member bundles carry no prices or purchase links (store policy).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('../services/challengeService');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const IST = 'Asia/Kolkata';
const TOR = 'America/Toronto';

// ── localDayOf ──────────────────────────────────────────────────────────────
{
  // 20:00 UTC = 01:30 next day in Kolkata, 16:00 same day in Toronto.
  eq(C.localDayOf('2026-10-15 20:00:00', true, IST, 'UTC'), '2026-10-16', 'naive UTC 20:00 is the next day in Kolkata');
  eq(C.localDayOf('2026-10-15 20:00:00', true, TOR, 'UTC'), '2026-10-15', 'naive UTC 20:00 is the same day in Toronto');
  // A naive value written by an IST database session.
  eq(C.localDayOf('2026-10-15 23:30:00', true, IST, IST), '2026-10-15', 'naive IST wall time stays on its day in IST');
  eq(C.localDayOf('2026-10-15 23:30:00', true, TOR, IST), '2026-10-15', 'naive IST 23:30 is 14:00 Toronto (same day)');
  eq(C.localDayOf('2026-10-16 05:00:00', true, TOR, IST), '2026-10-15', 'naive IST 05:00 is the previous evening in Toronto');
  // DST ends in Toronto 2026-11-01 at 02:00 local (06:00 UTC).
  eq(C.localDayOf('2026-11-01 03:59:00', true, TOR, 'UTC'), '2026-10-31', 'Toronto EDT: 03:59 UTC is still Oct 31');
  eq(C.localDayOf('2026-11-01 04:00:00', true, TOR, 'UTC'), '2026-11-01', 'Toronto EDT: 04:00 UTC is Nov 1 00:00');
  eq(C.localDayOf('2026-11-02 04:30:00', true, TOR, 'UTC'), '2026-11-01', 'Toronto EST after DST: 04:30 UTC is Nov 1 23:30');
  eq(C.localDayOf('2026-11-02 05:00:00', true, TOR, 'UTC'), '2026-11-02', 'Toronto EST after DST: 05:00 UTC is Nov 2 00:00');
  // DST starts 2026-03-08 02:00 → 03:00 (gap).
  eq(C.localDayOf('2026-03-08 02:30:00', true, TOR, TOR), '2026-03-08', 'a naive time inside the DST gap resolves forward on the same day');
  // tz-aware inputs
  eq(C.localDayOf(Date.parse('2026-10-15T19:00:00Z'), false, IST), '2026-10-16', 'epoch ms → Kolkata day');
  eq(C.localDayOf('2026-10-15T19:00:00+00:00', false, TOR), '2026-10-15', 'ISO with offset → Toronto day');
  eq(C.localDayOf(new Date('2026-10-15T18:29:59Z'), false, IST), '2026-10-15', 'Date at 23:59:59 IST');
  eq(C.localDayOf(null, true, IST), null, 'null timestamp → null');
  eq(C.localDayOf('garbage', true, IST), null, 'garbage → null');
  eq(C.resolveTz('', IST), IST, 'blank user tz falls back');
  eq(C.resolveTz('Not/AZone', IST), IST, 'invalid user tz falls back');
  eq(C.localTimeLabel(Date.parse('2026-10-15T02:42:00Z'), IST), '8:12 am', 'time label');
  eq(C.dayNumberOf('2026-10-12', '2026-10-15'), 4, 'day number');
  eq(C.dateOfDay('2026-10-28', 7), '2026-11-03', 'date of day across months');
}

// ── evidence + task kinds ───────────────────────────────────────────────────
const DAY = '2026-10-15';
const ms = (iso) => Date.parse(iso);
// The DB session zone in these fixtures is UTC; the member lives in Kolkata.
function ev(raw) { return C.dayEvidence(raw, DAY, IST, 'UTC'); }
const T = (kind, params) => ({ id: kind, kind, params: params || {}, position: 1, points: 100 });
const goals = { goal_protein_g: 120 };

{
  // Check-in made 08:12 IST on the day (02:42 UTC).
  const ok = ev({ checkins: [{ checkin_date: DAY, created_at: '2026-10-15 02:42:00', updated_at: null, is_freeze: false, steps: 9000, water_ml: 3200, protein_g: 70, sleep_hours: 7.5 }] });
  assert(C.evaluateTask(T('daily_checkin'), ok, goals).done, 'check-in on the day counts');
  eq(C.evaluateTask(T('daily_checkin'), ok, goals).at, ms('2026-10-15T02:42:00Z'), 'completion time is the evidence time');
  assert(C.evaluateTask(T('steps', { steps: 8000 }), ok, goals).done, 'steps 9000 ≥ 8000');
  assert(!C.evaluateTask(T('steps', { steps: 10000 }), ok, goals).done, 'steps 9000 < 10000');
  assert(C.evaluateTask(T('water', { ml: 3000 }), ok, goals).done, 'water 3.2 L ≥ 3 L');
  assert(C.evaluateTask(T('sleep', { hours: 7 }), ok, goals).done, 'sleep 7.5 ≥ 7');

  // Back-dated: the row says the day, but it was created the next day.
  const late = ev({ checkins: [{ checkin_date: DAY, created_at: '2026-10-16 03:00:00', updated_at: null, is_freeze: false, steps: 9000 }] });
  assert(!C.evaluateTask(T('daily_checkin'), late, goals).done, 'back-dated check-in does NOT count');
  assert(!C.evaluateTask(T('steps', { steps: 8000 }), late, goals).done, 'back-dated check-in steps do NOT count');

  // Created before the day (the previous IST evening) but dated today → no.
  const early = ev({ checkins: [{ checkin_date: DAY, created_at: '2026-10-14 17:00:00', is_freeze: false }] });
  assert(!C.evaluateTask(T('daily_checkin'), early, goals).done, 'a check-in created on another day does NOT count');

  // Freeze rows never count.
  const frz = ev({ checkins: [{ checkin_date: DAY, created_at: '2026-10-15 02:42:00', is_freeze: true, steps: 9000 }] });
  assert(!C.evaluateTask(T('daily_checkin'), frz, goals).done, 'streak freeze row does NOT count');

  // Edited after the day ended: the check-in still exists, but its values are not trusted.
  const edited = ev({ checkins: [{ checkin_date: DAY, created_at: '2026-10-15 02:42:00', updated_at: '2026-10-16 04:00:00', is_freeze: false, steps: 500, protein_g: 10 }] });
  assert(C.evaluateTask(T('daily_checkin'), edited, goals).done, 'edited-later check-in still counts as a check-in');
  const editedUp = ev({ checkins: [{ checkin_date: DAY, created_at: '2026-10-15 02:42:00', updated_at: '2026-10-16 04:00:00', is_freeze: false, steps: 12000, protein_g: 200 }] });
  assert(!C.evaluateTask(T('steps', { steps: 8000 }), editedUp, goals).done, 'an edit after the day does NOT upgrade steps');
  assert(!C.evaluateTask(T('protein_target', { pct: 90 }), editedUp, goals).done, 'an edit after the day does NOT upgrade protein');
  const editedSameDay = ev({ checkins: [{ checkin_date: DAY, created_at: '2026-10-15 02:42:00', updated_at: '2026-10-15 15:00:00', is_freeze: false, steps: 12000 }] });
  assert(C.evaluateTask(T('steps', { steps: 8000 }), editedSameDay, goals).done, 'an edit on the same day counts');
}

{
  // Meals: two on the day (60 g + 50 g), one back-dated (log_date today, submitted tomorrow).
  const meals = [
    { log_date: DAY, submitted_ms: ms('2026-10-15T03:00:00Z'), protein: 60 },
    { log_date: DAY, submitted_ms: ms('2026-10-15T08:00:00Z'), protein: 50 },
    { log_date: DAY, submitted_ms: ms('2026-10-16T06:00:00Z'), protein: 80 }
  ];
  const e1 = ev({ meals });
  eq(e1.meals.length, 2, 'back-dated meal excluded');
  eq(e1.meal_protein, 110, 'meal protein sums only valid meals');
  const pr = C.evaluateTask(T('protein_target', { pct: 90 }), e1, goals);
  assert(pr.done, 'protein 110 ≥ 90% of 120 (108)');
  eq(pr.progress, { value: 110, target: 108, goal: 120, unit: 'g' }, 'protein progress');
  eq(pr.at, ms('2026-10-15T08:00:00Z'), 'protein done when the running total crossed the target');
  assert(!C.evaluateTask(T('protein_target', { pct: 90 }), e1, { goal_protein_g: 140 }).done, 'protein below 90% of a higher goal');
  // The larger of check-in protein and meal sum.
  const e2 = ev({ meals, checkins: [{ checkin_date: DAY, created_at: '2026-10-15 10:00:00', is_freeze: false, protein_g: 130 }] });
  eq(C.evaluateTask(T('protein_target', { pct: 90 }), e2, goals).progress.value, 130, 'protein uses max(check-in, meals)');
  // Default goal when the member never set one.
  eq(C.evaluateTask(T('protein_target', { pct: 90 }), e1, {}).progress.target, 108, 'default protein goal 120 g');
  const ml = C.evaluateTask(T('meals_logged', { count: 3 }), e1, goals);
  assert(!ml.done, '2 valid meals < 3');
  eq(ml.progress.value, 2, 'meals progress');
  assert(C.evaluateTask(T('meals_logged', { count: 2 }), e1, goals).done, '2 valid meals ≥ 2');
  // A meal with a missing submitted_at never counts.
  eq(ev({ meals: [{ log_date: DAY, submitted_ms: null, protein: 99 }] }).meals.length, 0, 'meal without submitted_at excluded');
}

{
  const coach = [
    { local_date: DAY, created_ms: ms('2026-10-15T12:00:00Z'), duration_seconds: 1500, total_sets: 12, area: 'lower' },
    { local_date: DAY, created_ms: ms('2026-10-17T12:00:00Z'), duration_seconds: 3000, total_sets: 20, area: 'upper' } // synced 2 days later
  ];
  const e = ev({ coach });
  eq(e.coach.length, 1, 'back-dated Coach Mode workout excluded');
  assert(C.evaluateTask(T('coach_workout', { min_minutes: 20 }), e, goals).done, '25 min Coach Mode ≥ 20');
  assert(!C.evaluateTask(T('coach_workout', { min_minutes: 30 }), e, goals).done, '25 min < 30');
  const onlyLate = ev({ coach: [coach[1]] });
  assert(!C.evaluateTask(T('coach_workout', { min_minutes: 20 }), onlyLate, goals).done, 'only a back-dated Coach Mode session → not done');
  const fewSets = ev({ coach: [{ local_date: DAY, created_ms: ms('2026-10-15T12:00:00Z'), duration_seconds: 1500, total_sets: 2 }] });
  assert(!C.evaluateTask(T('coach_workout', { min_minutes: 20 }), fewSets, goals).done, 'Coach Mode needs at least 3 sets');

  // My Workout rows: naive created_at, session_date business date.
  const wk = ev({ workouts: [
    { session_date: DAY, created_at: '2026-10-15 13:00:00', duration_seconds: 1800, workout_type: 'manual' },
    { session_date: null, created_at: '2026-10-15 14:00:00', duration_seconds: 200 }
  ] });
  eq(wk.workouts.length, 2, 'two workout rows on the day');
  assert(C.evaluateTask(T('workout_any', {}), wk, goals).done, 'any workout ≥ 5 min counts');
  const short = ev({ workouts: [{ session_date: DAY, created_at: '2026-10-15 13:00:00', duration_seconds: 240 }] });
  assert(!C.evaluateTask(T('workout_any', {}), short, goals).done, 'workouts under 5 minutes are ignored');
  const lateWk = ev({ workouts: [{ session_date: DAY, created_at: '2026-10-16 13:00:00', duration_seconds: 1800 }] });
  assert(!C.evaluateTask(T('workout_any', {}), lateWk, goals).done, 'back-dated My Workout row does NOT count');
  assert(C.evaluateTask(T('coach_workout', { min_minutes: 20, allow_any: true }), wk, goals).done, 'coach_workout with allow_any accepts a My Workout session');
  assert(!C.evaluateTask(T('coach_workout', { min_minutes: 20 }), wk, goals).done, 'coach_workout without allow_any ignores My Workout');
}

{
  const m = ev({ mind: [{ checkin_date: DAY, created_at: '2026-10-15 05:00:00' }], sunday: [{ created_at: '2026-10-15 06:00:00' }] });
  assert(C.evaluateTask(T('mind_checkin'), m, goals).done, 'mind check-in counts');
  assert(C.evaluateTask(T('sunday_checkin'), m, goals).done, 'Sunday check-in counts');
  const lateMind = ev({ mind: [{ checkin_date: DAY, created_at: '2026-10-16 05:00:00' }], sunday: [{ created_at: '2026-10-16 06:00:00' }] });
  assert(!C.evaluateTask(T('mind_checkin'), lateMind, goals).done, 'back-dated mind check-in does NOT count');
  assert(!C.evaluateTask(T('sunday_checkin'), lateMind, goals).done, 'a Sunday check-in from the next day does NOT count');
  assert(!C.evaluateTask(T('manual'), m, goals).done, 'manual tasks are never auto-completed');
  assert(!C.evaluateTask(T('daily_checkin'), null, goals).done, 'no evidence → not done');
}

{
  const tasks = [T('daily_checkin'), Object.assign(T('steps', { steps: 8000 }), { id: 's', position: 2 })];
  const e = ev({ checkins: [{ checkin_date: DAY, created_at: '2026-10-15 02:42:00', is_freeze: false, steps: 100 }] });
  const d = C.evaluateDay(tasks, e, goals);
  eq([d.done, d.total, d.all_done], [1, 2, false], 'evaluateDay counts');
  eq(C.dayPoints([{ id: 'a', points: 300 }, { id: 'b', points: 300 }], ['a', 'b']), C.POINTS_DAY_CAP, 'points are capped per day');
}

// ── completion rules ────────────────────────────────────────────────────────
{
  eq(C.minDaysFor({ length_days: 7 }), 6, 'starter: 6 of 7');
  eq(C.minDaysFor({ length_days: 15 }), 13, '15 days: 85% → 13');
  eq(C.minDaysFor({ length_days: 30 }), 26, '30 days: 85% → 26');
  eq(C.minDaysFor({ length_days: 7, min_days: 7 }), 7, 'explicit min_days wins');
  const S = (arr) => new Set(arr);
  eq(C.completionState({ length: 7, minDays: 6, todayDay: 7, doneDays: S([1, 2, 3, 4, 5, 6, 7]) }), 'completed', 'all 7 done → completed');
  eq(C.completionState({ length: 7, minDays: 6, todayDay: 7, doneDays: S([1, 2, 3, 4, 6, 7]) }), 'completed', '6 of 7 with day 7 done → completed on day 7');
  eq(C.completionState({ length: 7, minDays: 6, todayDay: 7, doneDays: S([1, 2, 3, 4, 5, 6]) }), 'active', '6 done, day 7 still open → active');
  eq(C.completionState({ length: 7, minDays: 6, todayDay: 8, doneDays: S([1, 2, 3, 4, 5, 6]) }), 'completed', '6 done, window closed → completed');
  eq(C.completionState({ length: 7, minDays: 6, todayDay: 8, doneDays: S([1, 2, 3, 4, 5]) }), 'failed', '5 of 7 after the window → failed');
  eq(C.completionState({ length: 7, minDays: 6, todayDay: 4, doneDays: S([1]) }), 'failed', 'two misses already → impossible → failed');
  eq(C.completionState({ length: 7, minDays: 6, todayDay: 3, doneDays: S([1]) }), 'active', 'one miss so far → still active (grace)');
  eq(C.graceLeft({ length: 7, minDays: 6, todayDay: 3, doneDays: S([1]) }), 0, 'grace used by the missed day 2');
  eq(C.graceLeft({ length: 7, minDays: 6, todayDay: 3, doneDays: S([1, 2]) }), 1, 'grace left with no misses');
  eq(C.challengeStreak(S([1, 2, 3]), 4), 3, 'streak counts through yesterday while today is open');
  eq(C.challengeStreak(S([1, 3, 4]), 4), 2, 'streak breaks on a missed day');
}

// ── reward keys ─────────────────────────────────────────────────────────────
{
  const keys = new Set();
  for (let d = 1; d <= 30; d++) keys.add(C.rewardKey('e1', 'day', d));
  ['complete', 'badge', 'certificate', 'discount', 'lm_call'].forEach((k) => keys.add(C.rewardKey('e1', k)));
  eq(keys.size, 35, 'reward keys unique per enrollment');
  assert(C.rewardKey('e1', 'day', 1) !== C.rewardKey('e2', 'day', 1), 'reward keys differ across enrollments');
  eq(C.coinEventKey('e1', 'day', 4), 'coins:challenge:e1:day:4', 'day coin event key');
  eq(C.coinEventKey('e1', 'complete'), 'coins:challenge:e1:complete', 'completion coin event key');
  eq(C.completionCoins({ rewards: { coins: 250 } }), 250, 'completion coins from rewards');
  eq(C.completionCoins({ rewards: {} }), C.COIN_RULES.CHALLENGE_COMPLETE, 'completion coins fallback');
}

// ── leaderboard ─────────────────────────────────────────────────────────────
{
  const now = ms('2026-10-20T12:00:00Z');
  const old = now - 10 * 86400000;
  const rows = [
    { id: 'a', role: 'user', status: 'active', points: 900, user_created_ms: old, completed_at: null, created_at: '2026-10-14T00:00:00Z' },
    { id: 'b', role: 'user', status: 'completed', points: 900, user_created_ms: old, completed_at: '2026-10-19T10:00:00Z', created_at: '2026-10-13T00:00:00Z' },
    { id: 'c', role: 'user', status: 'completed', points: 900, user_created_ms: old, completed_at: '2026-10-19T08:00:00Z', created_at: '2026-10-15T00:00:00Z' },
    { id: 'admin', role: 'admin', status: 'active', points: 5000, user_created_ms: old },
    { id: 'op', role: 'operator', status: 'active', points: 5000, user_created_ms: old },
    { id: 'bm', role: 'bloodmap', status: 'active', points: 5000, user_created_ms: old },
    { id: 'opt', role: 'user', status: 'active', points: 5000, user_created_ms: old, leaderboard_opt_out: true },
    { id: 'new', role: 'user', status: 'active', points: 5000, user_created_ms: now - 3600000 },
    { id: 'left', role: 'user', status: 'left', points: 5000, user_created_ms: old },
    { id: 'void', role: 'user', status: 'void', points: 5000, user_created_ms: old }
  ];
  const ranked = C.rankBoard(rows, now);
  eq(ranked.map((r) => r.id), ['c', 'b', 'a'], 'members only; ties by earlier finish, then earlier join');
  eq(ranked.map((r) => r.rank), [1, 2, 3], 'ranks 1..n');
  eq(C.displayName('arjun', 'Rao'), 'Arjun R.', 'first name + last initial');
  eq(C.displayName('Priya Devi', ''), 'Priya', 'first word when no last name');
  eq(C.displayName('', ''), 'Member', 'fallback display name');
  eq(C.initials('Arjun R.'), 'AR', 'initials');
}

// ── discount math ───────────────────────────────────────────────────────────
{
  eq(C.applyDiscount(1499900, 15), 1274900, '15% off ₹14,999 → ₹12,749 (whole rupees, floored)');
  eq(C.applyDiscount(100000, 0), 100000, '0% leaves the price');
  eq(C.applyDiscount(100000, 90), 50000, 'percent is clamped to 50');
  eq(C.applyDiscount(100, 15), 100, 'never below ₹1');
  const now = ms('2026-10-20T12:00:00Z');
  const d = { applies_to: ['guided', 'tribe_elite'], expires_at: '2026-10-30T00:00:00Z', used_at: null };
  assert(C.discountUsable(d, 'guided', now), 'usable for guided');
  assert(!C.discountUsable(d, 'core', now), 'not for core');
  assert(!C.discountUsable(Object.assign({}, d, { used_at: '2026-10-21T00:00:00Z' }), 'guided', now), 'used once → not usable');
  assert(!C.discountUsable(Object.assign({}, d, { expires_at: '2026-10-19T00:00:00Z' }), 'guided', now), 'expired → not usable');
  assert(!C.discountUsable(Object.assign({}, d, { applies_to: '{guided}' }), 'tribe_elite', now), 'pg text[] literal parsed');
  eq(C.discountPct({}), 15, 'default discount 15%');
  eq(C.discountPct({ CHALLENGE_UPGRADE_DISCOUNT_PCT: '20' }), 20, 'env discount');
  eq(C.discountPct({ CHALLENGE_UPGRADE_DISCOUNT_PCT: '80' }), 15, 'out-of-range env discount falls back');
}

// ── flag ────────────────────────────────────────────────────────────────────
{
  const member = { id: 'u1', role: 'user', email: 'a@b.c' };
  const admin = { id: 'a1', role: 'admin' };
  eq(C.flagConfig({}).mode, 'off', 'flag defaults OFF');
  assert(!C.isEnabledFor(member, C.flagConfig({})), 'off → member hidden');
  assert(!C.isEnabledFor(admin, C.flagConfig({})), 'off → staff hidden');
  assert(C.isEnabledFor(admin, C.flagConfig({ CHALLENGES_ENABLED: 'staff' })), 'staff → staff');
  assert(!C.isEnabledFor(member, C.flagConfig({ CHALLENGES_ENABLED: 'staff' })), 'staff → member hidden');
  assert(C.isEnabledFor(member, C.flagConfig({ CHALLENGES_ENABLED: 'allowlist', CHALLENGES_ALLOWLIST: 'A@B.C, x' })), 'allowlist by email (case-insensitive)');
  assert(!C.isEnabledFor({ id: 'u2', role: 'user' }, C.flagConfig({ CHALLENGES_ENABLED: 'allowlist', CHALLENGES_ALLOWLIST: 'x' })), 'allowlist excludes others');
  assert(C.isEnabledFor(member, C.flagConfig({ CHALLENGES_ENABLED: 'true' })), 'true → all');
  eq(C.flagConfig({ CHALLENGES_ENABLED: 'banana' }).mode, 'off', 'unknown value → off');
  assert(!C.isPublicEnabled(C.flagConfig({ CHALLENGES_ENABLED: 'staff' })), 'public surfaces need all');
  assert(C.isPublicEnabled(C.flagConfig({ CHALLENGES_ENABLED: 'all' })), 'public surfaces at all');
  assert(C.inQuietHours(22) && C.inQuietHours(6) && !C.inQuietHours(7) && !C.inQuietHours(19), 'quiet hours 22:00–07:00');
  eq(C.publicCount(49), null, 'public count hidden under 50');
  eq(C.publicCount(1248), 1240, 'public count rounded down to 10');
}

// ── admin validation ────────────────────────────────────────────────────────
{
  assert(!!C.validateChallengeInput({ id: 'x-1', slug: 'x-1', title: 'Only ₹499 today', length_days: 7, access: 'free' }, { create: true }).errors, 'price wording rejected');
  assert(!!C.validateChallengeInput({ id: 'x-1', slug: 'x-1', title: 'Fix your blood sugar', length_days: 7, access: 'free' }, { create: true }).errors, 'blood wording rejected');
  assert(!!C.validateChallengeInput({ id: 'x-1', slug: 'x-1', title: 'Cures fatigue', length_days: 7, access: 'free' }, { create: true }).errors, 'medical claim rejected');
  assert(!C.validateChallengeInput({ id: 'x-1', slug: 'x-1', title: 'Seven days strong', length_days: 7, access: 'free' }, { create: true }).errors, 'clean challenge accepted');
  assert(C.validateTaskInput({ day_number: 1, position: 1, kind: 'steps', title: '8,000 steps' }, 7).length === 0, 'valid task');
  assert(C.validateTaskInput({ day_number: 9, position: 1, kind: 'steps', title: 'x' }, 7).length > 0, 'task day beyond length rejected');
  assert(C.validateTaskInput({ day_number: 1, position: 1, kind: 'hack', title: 'x' }, 7).length > 0, 'unknown kind rejected');
}

// ── seed files ──────────────────────────────────────────────────────────────
{
  const dir = path.join(__dirname, '..', 'data', 'challenges');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  eq(files.sort(), ['reset-15.json', 'starter-7.json', 'transform-30.json'], 'three seed challenges');
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    eq(C.seedProblems(s), [], `${f} is valid`);
  }
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'starter-7.json'), 'utf8'));
  eq(st.access, 'free', 'starter is free');
  eq(st.day_titles[0], 'Daily check in + set your protein goal', 'Day 1 copy matches the mockup');
  eq(st.tasks.filter((t) => t.day_number === 4).map((t) => t.kind), ['daily_checkin', 'protein_target', 'coach_workout'], 'Day 4 tasks match the mockup');
}

// ── migration file == boot DDL ──────────────────────────────────────────────
{
  const sql = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'migrations', '20261015_challenges.sql'), 'utf8');
  const norm = (s) => s.replace(/--[^\n]*\n/g, '').replace(/\s+/g, ' ').trim();
  eq(norm(sql), norm(C.DDL.map((s) => s + ';').join('\n')), 'migration SQL matches the boot DDL');
  assert(!/\bDROP\b|\bRENAME\b|ALTER TABLE (?!challenge)/i.test(norm(sql)), 'migration is additive and touches only challenge tables');
}

// ── store policy: no prices / purchase links in member bundles ─────────────
{
  const files = ['public/js/challenges.js', 'public/js/challenges-loader.js', 'public/css/challenges.css'];
  for (const f of files) {
    const p = path.join(__dirname, '..', f);
    if (!fs.existsSync(p)) continue; // UI lands in a later commit
    const src = fs.readFileSync(p, 'utf8');
    assert(!/₹|\bINR\b|\bRs\.?\s?\d|\/pricing|razorpay|checkout/i.test(src), `${f} has no prices or purchase links`);
  }
}

if (failures.length) {
  console.error(`\nchallenges-unit: ${failures.length} of ${checks} checks FAILED`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`challenges-unit: ${checks} passed, 0 failed`);
